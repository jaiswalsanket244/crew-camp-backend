import * as express from "express";
import * as status from "http-status";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { ProjectTasksHelper } from "./helper";
import {
  convertTime,
  isValidObjectId,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import { Validator } from "node-input-validator";
import {
  CURRENT_TASK_STATUS,
  NotificationCategory,
  NotificationMessageKey,
  TASK_STATUS,
} from "../../utils/enums/enums";
import { translate } from "../../utils/i18n";
import { config } from "../../utils/configuration/config";
import { NotificationsHelpers } from "../notifications/helpers";
import { ProjectHelper } from "../projects/helper";
import { Types } from "mongoose";
import { MANAGE_TYPE, MY_TASKS_FILTER } from "../../utils/enums/tasks";

type mongoId = Types.ObjectId | string;

// Mirrors MY_TASKS_PAGE_SIZE in the app; MAX bounds an untrusted pageSize.
const MY_TASKS_DEFAULT_PAGE_SIZE = 20;
const MY_TASKS_MAX_PAGE_SIZE = 100;

export class ProjectTaskRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectId: "string|required",
        name: "string|required",
        severity: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const task = await ProjectTasksHelper.create(req.user._id, req.body);
      ProjectHelper.updateProjectInfo(task.projectId);

      if (req?.body?.assignedTo?.[0]) {
        req.body.assignedTo.map((u) => {
          this.invokeNotications(
            req.body.projectId,
            task._id,
            u.userId,
            req.user,
          );
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "project notes created succesfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getTasks = async (
    req: AuthenticatedRequest & { query: { taskId: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "string|required",
        taskId: "string",
        search: "string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (req.query.taskId && !isValidObjectId(req.query.taskId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values",
        });
      }

      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : undefined;

      const [tasks, myProjects, totalCount] = await Promise.all([
        ProjectTasksHelper.findAll({ ...req.query, limit }),
        ProjectHelper.getMyProjectsArray(req?.user?._id),
        ProjectTasksHelper.countByProject(req.query.projectId),
      ]);

      let data = [];
      if (tasks?.[0]) {
        data = tasks.map((d) => ({
          ...d,
          createdAt: convertTime(d.createdAt),
          isMember: myProjects.includes(req.query.projectId),
        }));
      }

      return SuccessResponse(res, status.OK, {
        data,
        totalCounts: totalCount,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Personal View — cross-project "my tasks".
   * GET /projectTasks/mine?filter=&status=&search=&page=&pageSize=
   *
   * DELETED is intentionally absent from the allowed `status` values, so a
   * client cannot use this endpoint to read soft-deleted tasks.
   */
  public static getMyTasks = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        filter: `in:${Object.values(MY_TASKS_FILTER).join(",")}`,
        status: `in:${CURRENT_TASK_STATUS.PENDING},${CURRENT_TASK_STATUS.COMPLETED}`,
        search: "string",
        page: "integer",
        pageSize: "integer",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const {
        filter,
        status: taskStatus,
        search,
      } = req.query as {
        filter?: MY_TASKS_FILTER;
        status?: string;
        search?: string;
      };

      // Clamped rather than trusted — pageSize becomes the aggregation's $limit.
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const pageSize = Math.min(
        MY_TASKS_MAX_PAGE_SIZE,
        Math.max(
          1,
          parseInt(req.query.pageSize as string, 10) ||
            MY_TASKS_DEFAULT_PAGE_SIZE,
        ),
      );

      // Authorization scope: ownership only counts inside projects the caller
      // is still an active member of.
      const projectIds = await ProjectHelper.getMyProjects(req.user._id);

      const result = await ProjectTasksHelper.findMine({
        userId: req.user._id,
        projectIds,
        filter: filter || MY_TASKS_FILTER.ASSIGNED,
        status: taskStatus,
        search,
        page,
        pageSize,
      });

      return SuccessResponse(res, status.OK, {
        message: "tasks fetched successfully",
        data: {
          // convertTime matches the humanized createdAt that GET /projectTasks
          // already returns, so the same task reads identically in both views.
          data: result.data.map((task) => ({
            ...task,
            createdAt: convertTime(task.createdAt),
          })),
          pagination: result.pagination,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateStatus = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectTaskId: "string|required",
        status: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (!TASK_STATUS.includes(req.body.status)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "status field is required",
          errors: "status field is required",
        });
      }

      const task = await ProjectTasksHelper.updateStatus(req.body);

      if (task?.projectId) {
        ProjectHelper.updateProjectInfo(task.projectId);
      }

      if (req.body.status == CURRENT_TASK_STATUS.COMPLETED) {
        const users = task?.assignedTo?.map((u) => u.userId) || [];
        users.push(task.userId);

        const url =
          config.APP_URL +
          `/ViewTask?projectId=${task.projectId}&taskId=${task._id}`;

        const notications = [];
        const completedParams = {
          actor: req.user.fullName,
          task: task.name,
        };
        users.map(async (u) => {
          const obj = {
            userId: u,
            message: translate(
              NotificationMessageKey.TASK_COMPLETED,
              completedParams,
            ),
            messageKey: NotificationMessageKey.TASK_COMPLETED,
            messageParams: completedParams,
            taskId: task._id,
            createdBy: req.user._id,
            category: NotificationCategory.TASK_COMPLETED,
            url,
          };
          notications.push(obj);
        });
        NotificationsHelpers.createAndSendNotfications(
          notications,
          true,
          task.name,
        );
      }

      return SuccessResponse(res, status.OK, {
        message: "status updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static update = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectTaskId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const taskData = await ProjectTasksHelper.findById(
        req.body.projectTaskId,
      );

      await ProjectTasksHelper.put(req.body);

      if (taskData?.projectId) {
        ProjectHelper.updateProjectInfo(taskData.projectId);
      }

      const createNotification = this.invokeNotications;

      if (req?.body?.update?.assignedTo?.[0]) {
        const oldUsers = taskData?.assignedTo?.map((u) => u.userId.toString());
        await Promise.all(
          req.body.update.assignedTo.map(async (u) => {
            if (!oldUsers.includes(u.userId.toString())) {
              createNotification(
                taskData.projectId,
                taskData._id,
                u.userId,
                req.user,
              );
            }
          }),
        );
      }

      return SuccessResponse(res, status.OK, {
        message: "status updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static invokeNotications = async (
    projectId: mongoId,
    taskId: mongoId,
    userId: mongoId,
    createdBy: { _id: mongoId; fullName: string },
  ) => {
    const projectData = await ProjectHelper.getProjectData(projectId);

    const url =
      config.APP_URL + `/ViewTask?projectId=${projectId}&taskId=${taskId}`;

    const messageParams = {
      actor: createdBy.fullName,
      project: projectData.name,
    };

    const notications: any = [
      {
        userId,
        message: translate(NotificationMessageKey.TASK_ASSIGNED, messageParams),
        messageKey: NotificationMessageKey.TASK_ASSIGNED,
        messageParams,
        taskId,
        createdBy: createdBy._id,
        category: NotificationCategory.TASK_ASSIGNED,
        url,
      },
    ];

    await NotificationsHelpers.createAndSendNotfications(
      notications,
      true,
      projectData.name,
    );
  };

  public static manage = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validatorPayload = {
        query: req.query,
        body: req.body,
      };

      const validator = new Validator(validatorPayload, {
        "query.taskId": "required|string",
        "query.type": "required|string",
        "body.userId": "required|string",
        "body.userName": "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { taskId, type } = req.query;

      switch (type) {
        case MANAGE_TYPE.JOIN:
          await ProjectTasksHelper.joinTask(ObjectId(taskId), req.body);
          break;

        case MANAGE_TYPE.LEAVE:
          await ProjectTasksHelper.leaveTask(
            ObjectId(taskId),
            ObjectId(req.body.userId),
          );
          break;

        default:
          break;
      }

      const task = await ProjectTasksHelper.findById(String(taskId));
      if (task?.projectId) {
        ProjectHelper.updateProjectInfo(task.projectId);
      }

      return SuccessResponse(res, status.OK, {
        message: "Updated succesfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
