import {
  ObjectIdType,
  ProjectTaskType,
} from "../../utils/interfaces/schemaInterface";
import { ProjectTasks } from "../../db";
import {
  escapeRegExp,
  getProjectNamePipeline,
  getUserNamePipeline,
  isValidObjectId,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import { CURRENT_TASK_STATUS } from "../../utils/enums/enums";
import {
  IMyTaskRow,
  IMyTasksQuery,
  IMyTasksResult,
  IProjectTasksFindAll,
} from "../../utils/interfaces/projectTasks";
import { MY_TASKS_FILTER } from "../../utils/enums/tasks";
import { PipelineStage } from "mongoose";

export interface ProjectTasksQuery {
  projectId: string;
  page: number;
  skips?: number;
  pageSize: number;
}

// Bound on user-supplied search text before it reaches $regex — matches the
// cap the checklist and report "mine" endpoints apply.
const SEARCH_MAX_LENGTH = 100;

export class ProjectTasksHelper {
  public static create = async (userId: string, body: ProjectTaskType) => {
    const { name, description, projectId, severity, assignedTo, taskImage } =
      body;

    return ProjectTasks.create({
      userId,
      projectId,
      name,
      description,
      severity,
      assignedTo,
      taskImage,
    });
  };

  // Tab badge count for Tasks. Mirrors findAll's filter — excludes DELETED tasks
  // (PENDING + COMPLETED are counted), matching the Tasks tab.
  //
  // Guarded exactly like findAll, which returns [] on a bad id: callers hand it
  // req.query.projectId unchecked, and ObjectId() throws on a malformed id while
  // silently minting a RANDOM one on undefined. Without this, adding the count
  // to a list route turns a request that used to 200 with an empty list into a
  // 500, or bills a query that can never match anything.
  public static countByProject = async (projectId?: string) => {
    if (!projectId || !isValidObjectId(projectId)) return 0;
    return ProjectTasks.countDocuments({
      projectId: ObjectId(projectId),
      status: { $ne: CURRENT_TASK_STATUS.DELETED },
    });
  };

  public static findAll = async ({
    projectId,
    taskId,
    search,
    limit,
  }: IProjectTasksFindAll) => {
    if (!isValidObjectId(projectId)) return [];
    const userNamePipeline = getUserNamePipeline();
    const projectNamePipeline = getProjectNamePipeline();

    const query: any = {
      status: { $ne: CURRENT_TASK_STATUS.DELETED },
    };

    if (taskId) query._id = ObjectId(taskId);
    else query.projectId = ObjectId(projectId);

    if (search) {
      // Literal substring match — escaped so metacharacters can't be
      // interpreted as a pattern, capped so it can't pin CPU. Same treatment as
      // findMine below: an unbalanced pattern like "(" is rejected by Mongo
      // outright, and this helper backs /projects/search's task count as well as
      // the Tasks tab, so that would 500 the whole tab bar, not just this list.
      const regex = {
        $regex: escapeRegExp(String(search).slice(0, SEARCH_MAX_LENGTH)),
        $options: "i",
      };
      query["$or"] = [{ name: regex }, { description: regex }];
    }

    const pipeline: any[] = [
      {
        $match: query,
      },
      ...userNamePipeline,
      ...projectNamePipeline,
      {
        $project: {
          name: 1,
          description: 1,
          createdAt: 1,
          userName: 1,
          status: 1,
          projectName: 1,
          assignedTo: 1,
          severity: 1,
          taskImage: 1,
          userId: 1,
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      },
    ];

    if (limit) {
      pipeline.push({ $limit: limit });
    }

    return ProjectTasks.aggregate(pipeline);
  };

  /**
   * Personal View — cross-project "my tasks" (GET /projectTasks/mine).
   *
   * Ownership (created/assigned) is always intersected with the caller's active
   * project memberships, so tasks in projects they were removed from drop out.
   * The $lookups run after $skip/$limit so they only touch the current page's
   * rows.
   *
   * $sort lives inside the `data` branch, not before the $facet: ordering is
   * meaningless to $count, and $facet is not a $limit, so a $sort above it gets
   * nothing pushed down and blocks on the full match set against the 100MB
   * aggregation limit. Directly above $skip/$limit it becomes a bounded top-k
   * sort. No index serves { createdAt, _id } here — { projectId: 1 } stops at
   * projectId — so keeping the sort bounded is what protects this endpoint.
   */
  public static findMine = async ({
    userId,
    projectIds,
    filter,
    status,
    search,
    page,
    pageSize,
  }: IMyTasksQuery): Promise<IMyTasksResult> => {
    const emptyResult: IMyTasksResult = {
      data: [],
      pagination: { page, pageSize, totalCount: 0, totalPages: 0 },
    };

    // No active memberships means nothing can be "mine" — skip the round trip.
    if (!projectIds.length) return emptyResult;

    const assignedToMe = { "assignedTo.userId": userId };
    const createdByMe = { userId };

    let ownership: Record<string, unknown>;
    if (filter === MY_TASKS_FILTER.CREATED) {
      ownership = createdByMe;
    } else if (filter === MY_TASKS_FILTER.ALL) {
      ownership = { $or: [assignedToMe, createdByMe] };
    } else {
      ownership = assignedToMe;
    }

    // Composed as $and because both `ownership` and `search` can contribute an
    // $or, and sibling $or keys would overwrite each other in a flat object.
    const conditions: Record<string, unknown>[] = [
      { projectId: { $in: projectIds } },
      { status: status || { $ne: CURRENT_TASK_STATUS.DELETED } },
      ownership,
    ];

    if (search) {
      // Literal substring match — escaped so metacharacters can't be
      // interpreted as a pattern, capped so it can't pin CPU.
      const regex = {
        $regex: escapeRegExp(String(search).slice(0, SEARCH_MAX_LENGTH)),
        $options: "i",
      };
      conditions.push({
        $or: [{ name: regex }, { description: regex }],
      });
    }

    const skips = (page - 1) * pageSize;

    const pipeline: PipelineStage[] = [
      { $match: { $and: conditions } },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            // _id breaks createdAt ties so a row can't repeat or vanish across
            // pages. Immediately above $skip/$limit so Mongo bounds the sort.
            { $sort: { createdAt: -1, _id: -1 } },
            { $skip: skips },
            { $limit: pageSize },
            ...getUserNamePipeline(),
            ...getProjectNamePipeline(),
            {
              $project: {
                name: 1,
                description: 1,
                createdAt: 1,
                userName: 1,
                status: 1,
                projectId: 1,
                projectName: 1,
                assignedTo: 1,
                severity: 1,
                taskImage: 1,
                userId: 1,
                isProjectArchived: {
                  $ne: [{ $ifNull: ["$archivedAt", null] }, null],
                },
              },
            },
          ],
        },
      },
    ];

    const result = await ProjectTasks.aggregate<{
      metadata: { total: number }[];
      data: IMyTaskRow[];
    }>(pipeline);

    const totalCount = result?.[0]?.metadata?.[0]?.total || 0;

    return {
      data: result?.[0]?.data || [],
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
      },
    };
  };

  public static updateStatus = async ({ projectTaskId, status }) => {
    return ProjectTasks.findByIdAndUpdate(
      projectTaskId,
      { $set: { status } },
      { new: true },
    );
  };

  public static put = async ({ projectTaskId, update }) => {
    return ProjectTasks.findByIdAndUpdate(projectTaskId, { $set: update });
  };

  public static findById = async (projectTaskId: string) => {
    return ProjectTasks.findById(projectTaskId);
  };

  public static joinTask = async (
    taskId: ObjectIdType,
    user: { userId: ObjectIdType; userName: string },
  ) => {
    return ProjectTasks.findByIdAndUpdate(taskId, {
      $push: { assignedTo: user },
    });
  };

  public static leaveTask = async (
    taskId: ObjectIdType,
    userId: ObjectIdType,
  ) => {
    return ProjectTasks.findByIdAndUpdate(taskId, {
      $pull: { assignedTo: { userId } },
    });
  };

  public static getDeletedTasks = async (projectIds: ObjectIdType[]) => {
    const userNamePipeline = getUserNamePipeline();
    const projectNamePipeline = getProjectNamePipeline();

    const query: any = {
      status: CURRENT_TASK_STATUS.DELETED,
      projectId: { $in: projectIds },
      // Excludes tasks binned along with their project (projects bin owns those).
      preDeleteStatus: { $exists: false },
    };

    return ProjectTasks.aggregate([
      {
        $match: query,
      },
      ...userNamePipeline,
      ...projectNamePipeline,
      {
        $project: {
          name: 1,
          description: 1,
          createdAt: 1,
          userName: 1,
          status: 1,
          projectName: 1,
          assignedTo: 1,
          severity: 1,
          taskImage: 1,
          userId: 1,
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      },
    ]);
  };

  public static restoreDeletedTask = async (projectTaskId) => {
    return ProjectTasks.findByIdAndUpdate(
      projectTaskId,
      { $set: { status: CURRENT_TASK_STATUS.PENDING } },
      { new: true },
    );
  };
}
