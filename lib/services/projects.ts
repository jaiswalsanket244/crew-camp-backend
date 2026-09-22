/**
 * Project bin service.
 *
 * Deleting a project is a two-stage operation:
 *
 *   1. Soft delete — the project is flagged DELETED and stamped with deletedAt,
 *      and every piece of content hanging off it is soft-deleted too. Project
 *      listings already filter `status: ACTIVE` (as does the OpenSearch project
 *      query), so the project disappears everywhere on its own; cascading the
 *      children is what keeps their content out of company-wide feeds, which
 *      filter child status but never join the parent project.
 *
 *   2. Purge — after TRASHBIN_NO_OF_DAYS, a nightly cron permanently
 *      removes the project and everything under it, including S3 objects.
 *
 * Cascaded rows carry `preDeleteStatus`, holding the status they had before the
 * project was binned. That serves two purposes: per-entity bins hide rows that
 * have it (so binning one project doesn't flood the posts bin with 400 entries),
 * and a restore puts back the exact prior value — which matters for tasks and
 * checklists, where the status is PENDING/COMPLETED rather than a plain ACTIVE.
 */

import { Model, Types } from "mongoose";
import {
  Checklist,
  Comments,
  CrewsProjects,
  DailyLogs,
  DeletedPostFiles,
  Files,
  InvitedUsers,
  Notification,
  PostFiles,
  Posts,
  Project,
  ProjectMember,
  ProjectNotes,
  ProjectReports,
  ProjectTasks,
  SyncJob,
} from "../db";
import { TRASHBIN_NO_OF_DAYS } from "../utils/constants/constants";
import { CURRENT_STATUS, CURRENT_TASK_STATUS } from "../utils/enums/enums";
import { CHECKLIST_STATUS } from "../utils/enums/checklist";
import { REPORT_STATUS } from "../utils/enums/projectReports";
import { DAILY_LOG_STATUS } from "../utils/enums/dailyLog";
import { removeDays } from "../utils/helpers/commonHelper";
import { ObjectIdType } from "../utils/interfaces/schemaInterface";
import { PostService } from "./posts";
import { FilesService } from "./files";
import { TasksService } from "./tasks";
import { ChecklistsServices } from "./checklists";
import { ProjectReportServices } from "./projectReport";
import { ProjectPinHelper } from "../routes/projects/pinsHelper";
import { fileService } from "./awsBucket";

/**
 * Collections soft-deleted alongside their project.
 *
 * `deletedValue` differs per collection on purpose — these are separate enums
 * and two of them are lowercase. Writing a single "DELETED" everywhere would
 * fail schema validation on reports and daily logs.
 */
const CASCADE_COLLECTIONS: {
  key: string;
  model: Model<unknown>;
  deletedValue: string;
}[] = [
  {
    key: "posts",
    model: Posts as unknown as Model<unknown>,
    deletedValue: CURRENT_STATUS.DELETED,
  },
  {
    key: "postFiles",
    model: PostFiles as unknown as Model<unknown>,
    deletedValue: CURRENT_STATUS.DELETED,
  },
  {
    key: "files",
    model: Files as unknown as Model<unknown>,
    deletedValue: CURRENT_STATUS.DELETED,
  },
  {
    key: "comments",
    model: Comments as unknown as Model<unknown>,
    deletedValue: CURRENT_STATUS.DELETED,
  },
  {
    key: "checklists",
    model: Checklist as unknown as Model<unknown>,
    deletedValue: CHECKLIST_STATUS.DELETED,
  },
  {
    key: "tasks",
    model: ProjectTasks as unknown as Model<unknown>,
    deletedValue: CURRENT_TASK_STATUS.DELETED,
  },
  {
    key: "notes",
    model: ProjectNotes as unknown as Model<unknown>,
    deletedValue: CURRENT_STATUS.DELETED,
  },
  {
    key: "reports",
    model: ProjectReports as unknown as Model<unknown>,
    deletedValue: REPORT_STATUS.DELETED,
  },
  {
    key: "dailyLogs",
    model: DailyLogs as unknown as Model<unknown>,
    deletedValue: DAILY_LOG_STATUS.DELETED,
  },
  {
    key: "members",
    model: ProjectMember as unknown as Model<unknown>,
    deletedValue: CURRENT_STATUS.DELETED,
  },
];

// Purging a large project fans out to S3; cap how many deletes are in flight.
const PURGE_BATCH_SIZE = 25;

async function inBatches<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export class ProjectService {
  /**
   * Move a project and all of its content to the bin.
   *
   * Rows already sitting in their own bin are skipped (`status: { $ne }`), so
   * something the user deleted by hand stays deleted after a project restore
   * and keeps showing in its own bin. The `preDeleteStatus` guard makes a
   * repeated call a no-op rather than overwriting the saved status with DELETED.
   */
  static softDeleteProject = async (
    projectId: ObjectIdType,
  ): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};

    for (const { key, model, deletedValue } of CASCADE_COLLECTIONS) {
      const result = await model.updateMany(
        {
          projectId,
          status: { $ne: deletedValue },
          preDeleteStatus: { $exists: false },
        },
        [{ $set: { preDeleteStatus: "$status", status: deletedValue } }],
      );
      counts[key] = result.modifiedCount ?? 0;
    }

    // Pins are join rows with no status: drop them outright, matching how the
    // merge flow treats them. A pin to a binned project would otherwise sit
    // invisibly against the user's pin cap.
    await ProjectPinHelper.deleteByProject(projectId);

    await Project.updateOne(
      { _id: projectId },
      { $set: { status: CURRENT_STATUS.DELETED, deletedAt: new Date() } },
    );

    return counts;
  };

  /**
   * Restore a binned project, putting every cascaded row back to the exact
   * status it held before. Rows without `preDeleteStatus` are left alone —
   * those were deleted individually and are not ours to revive.
   */
  static restoreProject = async (
    projectId: ObjectIdType,
  ): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};

    for (const { key, model } of CASCADE_COLLECTIONS) {
      const result = await model.updateMany(
        { projectId, preDeleteStatus: { $exists: true } },
        [
          { $set: { status: "$preDeleteStatus" } },
          { $unset: "preDeleteStatus" },
        ],
      );
      counts[key] = result.modifiedCount ?? 0;
    }

    await Project.updateOne(
      { _id: projectId },
      {
        $set: { status: CURRENT_STATUS.ACTIVE },
        $unset: { deletedAt: "" },
      },
    );

    return counts;
  };

  /**
   * Permanently delete a project and everything under it.
   *
   * Content that owns S3 objects goes through its own service so the files are
   * removed too — deleting the rows directly would orphan every image in the
   * bucket. Ordering matters: children first, project last, so an interrupted
   * purge leaves the project in the bin and is simply retried next run.
   */
  static purgeProject = async (projectId: ObjectIdType): Promise<void> => {
    // Posts: removes post files, comment attachments and their S3 objects.
    const posts = await Posts.find({ projectId }, { _id: 1 }).lean();
    await inBatches(posts, PURGE_BATCH_SIZE, (post) =>
      PostService.deletePostsById(post._id),
    );

    // Standalone files (gallery//api/file uploads) — each deletes its S3 object.
    const files = await Files.find({ projectId }, { _id: 1 }).lean();
    await inBatches(files, PURGE_BATCH_SIZE, (file) =>
      FilesService.deleteFileById(file._id as ObjectIdType),
    );

    const tasks = await ProjectTasks.find({ projectId }, { _id: 1 }).lean();
    await inBatches(tasks, PURGE_BATCH_SIZE, (task) =>
      TasksService.deleteTaskById(task._id),
    );

    const checklists = await Checklist.find({ projectId }, { _id: 1 }).lean();
    await inBatches(checklists, PURGE_BATCH_SIZE, (checklist) =>
      ChecklistsServices.deleteChecklistById(checklist._id),
    );

    // deleteReportById clears sub-section images but not the cover image, so
    // collect those here before the rows go.
    const reports = await ProjectReports.find(
      { projectId },
      { _id: 1, coverPageImage: 1 },
    ).lean();
    const coverImages = reports
      .map((report) => report.coverPageImage)
      .filter((url): url is string => Boolean(url));

    await inBatches(reports, PURGE_BATCH_SIZE, (report) =>
      ProjectReportServices.deleteReportById(report._id as ObjectIdType),
    );
    await inBatches(coverImages, PURGE_BATCH_SIZE, (url) =>
      fileService.deleteFromS3UsingLink(url),
    );

    // Note attachments are uploaded to the note itself (url only, no post/file
    // linkage), so nothing else will ever remove them from S3.
    const notes = await ProjectNotes.find(
      { projectId },
      { "files.url": 1 },
    ).lean();
    const noteFileUrls = notes.flatMap((note) =>
      (note.files ?? [])
        .map((file: { url?: string }) => file?.url)
        .filter((url): url is string => Boolean(url)),
    );
    await inBatches(noteFileUrls, PURGE_BATCH_SIZE, (url) =>
      fileService.deleteFromS3UsingLink(url),
    );

    // Daily-log photos are deliberately NOT deleted here: each entry carries a
    // fileId/postId pointing at a PostFiles row, so the image belongs to the
    // post and was already removed with it above.

    // Files trashed before the project was binned still hold S3 objects.
    const deletedPostFiles = await DeletedPostFiles.find(
      { projectId },
      { _id: 1 },
    ).lean();
    await inBatches(deletedPostFiles, PURGE_BATCH_SIZE, (file) =>
      PostService.deletePostFileById(file._id),
    );

    // Remaining rows carry no external storage — plain deletes.
    await Promise.all([
      Posts.deleteMany({ projectId }),
      PostFiles.deleteMany({ projectId }),
      Files.deleteMany({ projectId }),
      Comments.deleteMany({ projectId }),
      Checklist.deleteMany({ projectId }),
      ProjectTasks.deleteMany({ projectId }),
      ProjectNotes.deleteMany({ projectId }),
      ProjectReports.deleteMany({ projectId }),
      DailyLogs.deleteMany({ projectId }),
      DeletedPostFiles.deleteMany({ projectId }),
      ProjectMember.deleteMany({ projectId }),
      CrewsProjects.deleteMany({ projectId }),
      InvitedUsers.deleteMany({ projectId }),
      Notification.deleteMany({ projectId }),
      SyncJob.deleteMany({ projectId }),
      ProjectPinHelper.deleteByProject(projectId),
    ]);

    // Last, so the project stays in the bin and retries if anything above threw.
    await Project.deleteOne({ _id: projectId });
  };

  /**
   * Nightly cron entry: purge projects binned longer than the retention window.
   *
   * Uses the explicit deletedAt stamp rather than updatedAt, so a later write to
   * a binned project can't silently push its purge date back.
   */
  static deleteProjectsInBin = async (): Promise<number> => {
    try {
      const cutoff = removeDays(new Date(), TRASHBIN_NO_OF_DAYS);

      const projects = await Project.find(
        {
          status: CURRENT_STATUS.DELETED,
          deletedAt: { $lt: cutoff },
        },
        { _id: 1 },
      ).lean();

      let purged = 0;
      for (const project of projects) {
        try {
          await ProjectService.purgeProject(
            project._id as unknown as Types.ObjectId,
          );
          purged += 1;
        } catch (error) {
          // One bad project must not stop the rest of the run; it stays in the
          // bin and is retried tomorrow.
          console.error(`Failed to purge project ${project._id}:`, error);
        }
      }

      return purged;
    } catch (error) {
      console.error("deleteProjectsInBin failed:", error);
      return 0;
    }
  };
}
