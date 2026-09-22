import { createHash } from "crypto";
import { Types } from "mongoose";
import { ProjectHelper } from "../projects/helper";
import { PostsHelper } from "../posts/helper";
import { PostsRoutes } from "../posts/routes";
import { ProjectTasksHelper } from "../projectTasks/helper";
import { ChecklistHelper } from "../checklist/helper";
import { TagsHelper } from "../tags/helper";
import { Company } from "../../db";
import { CHECKLIST_STATUS, CHECKLIST_TYPE } from "../../utils/enums/checklist";
import { TAGS_FOR } from "../../utils/enums/enums";
import { convertTime, ObjectId } from "../../utils/helpers/commonHelper";
import {
  IOfflineBundleTags,
  IOfflineBundleUser,
  IOfflineProjectBundle,
} from "../../utils/interfaces/offline";

export class OfflineHelper {
  public static MAX_PROJECTS = 5;
  public static MAX_UPLOAD_FILES = 10;
  public static UPLOADS_PAGE_SIZE = 10;

  public static getTargetProjectIds = async (
    userId: Types.ObjectId,
  ): Promise<string[]> => {
    const projects = await ProjectHelper.findAll({ userId });
    return projects
      .slice(0, this.MAX_PROJECTS)
      .map((project) => project._id.toString());
  };

  private static trimUploads = (
    buckets: Record<string, unknown>[],
  ): Record<string, unknown>[] => {
    const page = buckets?.[0] as { items?: Record<string, unknown>[] };
    if (!page?.items?.length) {
      return [];
    }

    let filesKept = 0;
    const trimmedItems = [];

    for (const item of page.items) {
      const posts = (item?.posts || []) as Record<string, unknown>[];
      const trimmedPosts = [];

      for (const post of posts) {
        if (filesKept >= this.MAX_UPLOAD_FILES) break;
        const files = (post?.files || []) as Record<string, unknown>[];
        const keptFiles = files.slice(0, this.MAX_UPLOAD_FILES - filesKept);
        if (!keptFiles.length) continue;
        filesKept += keptFiles.length;
        trimmedPosts.push({ ...post, files: keptFiles });
      }

      if (trimmedPosts.length) {
        trimmedItems.push({ ...item, posts: trimmedPosts });
      }
      if (filesKept >= this.MAX_UPLOAD_FILES) break;
    }

    return trimmedItems;
  };

  private static getUploads = async (
    projectId: string,
    user: IOfflineBundleUser,
    timeZone?: string,
  ) => {
    const query = {
      page: 1,
      pageSize: this.UPLOADS_PAGE_SIZE,
      limit: this.UPLOADS_PAGE_SIZE,
      skips: 0,
      projectId,
      projectIds: [],
      timeZone,
    };

    const posts = await PostsHelper.findAllUploads(query as never, {
      userId: user._id,
      role: user.role,
      companyIds: [user.companyId],
    });

    const buckets = posts as unknown as Record<string, unknown>[];
    PostsRoutes.bucketUploadsByDate(buckets as never, { timeZone });
    return this.trimUploads(buckets);
  };

  public static getProjectBundle = async (
    projectId: string,
    user: IOfflineBundleUser,
    timeZone?: string,
  ): Promise<IOfflineProjectBundle> => {
    const project = await ProjectHelper.getProjectData(projectId);

    const [detailsList, uploads, tasks, checklists] = await Promise.all([
      ProjectHelper.getProjectDetails(
        projectId,
        project?.companyId || (projectId as unknown as Types.ObjectId),
      ),
      this.getUploads(projectId, user, timeZone),
      ProjectTasksHelper.findAll({ projectId, search: "" }),
      ChecklistHelper.findAllChecklist({
        type: CHECKLIST_TYPE.CHECKLIST,
        status: { $ne: CHECKLIST_STATUS.DELETED },
        projectId: ObjectId(projectId),
      }),
    ]);

    const rawDetails = detailsList?.[0];
    const details = rawDetails
      ? {
          ...rawDetails,
          createdAt: convertTime(rawDetails.createdAt, true),
          allowComment: true,
          isMember: true,
          canJoin: false,
          isGuest: false,
        }
      : {};

    return {
      details,
      uploads,
      tasks: (tasks || []).map((task) => ({
        ...task,
        createdAt: convertTime(task.createdAt, true),
        isMember: true,
      })),
      checklists: (checklists || []).map((checklist) => ({
        ...checklist,
        isMember: true,
      })),
    };
  };

  public static getTags = async (
    companyId: Types.ObjectId,
  ): Promise<IOfflineBundleTags> => {
    const company = companyId
      ? await Company.findById(companyId, { showDefaultTags: 1 }).lean()
      : null;
    const showDefaultTags = company?.showDefaultTags !== false;
    const companyIdValue = companyId?.toString();

    const [postCustom, projectCustom, postDefault, projectDefault] =
      await Promise.all([
        TagsHelper.getCustom(companyIdValue, TAGS_FOR.POST),
        TagsHelper.getCustom(companyIdValue, TAGS_FOR.PROJECT),
        showDefaultTags ? TagsHelper.getDefault(TAGS_FOR.POST) : [],
        showDefaultTags ? TagsHelper.getDefault(TAGS_FOR.PROJECT) : [],
      ]);

    return {
      post: [...postDefault, ...postCustom],
      project: [...projectDefault, ...projectCustom],
    };
  };

  public static buildVersion = (payload: unknown): string =>
    createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}
