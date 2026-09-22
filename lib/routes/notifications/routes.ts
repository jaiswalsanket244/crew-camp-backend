import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { Response, NextFunction } from "express";
import { NotificationsHelpers } from "./helpers";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import * as status from "http-status";
import { NotificationType } from "../../utils/interfaces/schemaInterface";
import { convertTime } from "../../utils/helpers/commonHelper";
import { ProjectTasksHelper } from "../projectTasks/helper";
import { isAdminUser } from "../../utils/helpers/users";
import { PostFiles } from "../../db";
import {
  CURRENT_STATUS,
  NotificationCategory,
  NotificationMessageKey,
  SUPPORTED_LANGUAGES,
} from "../../utils/enums/enums";
import { Validator } from "node-input-validator";
import {
  resolveLocale,
  translate,
  translateNotification,
} from "../../utils/i18n";

export class NotificationsRoutes {
  public static getPreferences = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const data = await NotificationsHelpers.getPreferences(req.user._id);
      return SuccessResponse(res, status.OK, {
        message: "Notification preferences retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static updatePreferences = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    try {
      const data = await NotificationsHelpers.updatePreferences(
        req.user._id,
        req.body,
      );
      return SuccessResponse(res, status.OK, {
        message: "Notification preferences updated successfully.",
        data,
      });
    } catch (error) {
      return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
        message: "Validation error",
        errors: error instanceof Error ? error.message : error,
      });
    }
  };

  public static get = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        lang: `string|in:${SUPPORTED_LANGUAGES.join(",")}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const userId = req.user._id;
      const locale = resolveLocale(req);

      const data = await NotificationsHelpers.findAll(userId, req.query);

      if (data?.[0]?.items) {
        data[0].items = await Promise.all(
          data[0].items.map(async (d) => {
            let files = [];
            const isPost = d?.url?.includes("?postId=");
            const isTask = d?.url?.includes("&taskId=");
            if (isPost || isTask) {
              const id = isPost ? d.postId : d.taskId;
              if (isPost) {
                files = await PostFiles.find({
                  postId: id,
                  status: CURRENT_STATUS.ACTIVE,
                })
                  .sort({ position: 1, createdAt: 1 })
                  .lean();
              } else if (isTask) {
                const taskData = await ProjectTasksHelper.findById(id);
                if (taskData?.taskImage) {
                  files.push({
                    url: taskData.taskImage,
                    fileType: "image",
                  });
                }
              }
            }
            return {
              ...translateNotification(d, locale),
              files,
              createdAt: convertTime(d.createdAt),
            };
          }),
        );
      }
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (err) {
      next(err);
    }
  };

  public static create = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      await NotificationsHelpers.createAndSendNotfications(
        [
          {
            userId,
            message: translate(NotificationMessageKey.TEST_NOTIFICATION),
            messageKey: NotificationMessageKey.TEST_NOTIFICATION,
            createdBy: userId,
            category: NotificationCategory.OTHER,
          },
        ],
        true,
        "Test notification",
      );
      return SuccessResponse(res, status.OK, { message: "Success." });
    } catch (err) {
      next(err);
    }
  };

  public static getOne = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const id = req.params.id;
      const locale = resolveLocale(req);
      const notifications = await NotificationsHelpers.findOne(id);
      const data = notifications.map((notification) =>
        translateNotification(notification, locale),
      );
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static update = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const id = req.params.id;
      const { update }: { update: NotificationType } = req.body;
      const data = await NotificationsHelpers.findAndUpdate({ id, update });
      return SuccessResponse(res, status.OK, {
        message: "Data updated successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static delete = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const notificationId = req.params.id;
      const userId = req.user._id;
      const data = await NotificationsHelpers.delete(notificationId, userId);
      return SuccessResponse(res, status.OK, {
        message: "Notification deleted successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static clearAllNotifications = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const data = await NotificationsHelpers.clearNotifications(userId);
      return SuccessResponse(res, status.OK, {
        message: "Notification cleared successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static markAsRead = async (
    req: AuthenticatedRequest & { query: { notificationId: string } },
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { notificationId } = req.query;
      const data = await NotificationsHelpers.findAndUpdate({
        id: notificationId,
        update: { isOpened: true },
      });
      return SuccessResponse(res, status.OK, {
        message: "Notification cleared successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getUnreadCount = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const isAdmin = isAdminUser(req.user.companies?.[0]?.role);
      const count = await NotificationsHelpers.getUnreadCount(userId, isAdmin);
      return SuccessResponse(res, status.OK, {
        message: "Unread count retrieved successfully.",
        data: count,
      });
    } catch (error) {
      next(error);
    }
  };

  public static markAllAsRead = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const { isInvitations } = req.query;
      const data = await NotificationsHelpers.markAllAsRead(
        userId,
        isInvitations,
      );
      return SuccessResponse(res, status.OK, {
        message: "Notifications marked as read successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
