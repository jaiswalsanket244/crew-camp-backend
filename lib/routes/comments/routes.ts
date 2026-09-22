import * as express from "express";
import * as status from "http-status";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  getDaysDiff,
  isValidObjectId,
  ObjectId,
  verifyToken,
} from "../../utils/helpers/commonHelper";
import { CommentHelper } from "./helper";
import { CommentType } from "../../utils/interfaces/schemaInterface";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
import { config } from "../../utils/configuration/config";
import { NotificationsHelpers } from "../notifications/helpers";
import { PostsHelper } from "../posts/helper";
import { ProjectHelper } from "../projects/helper";
import { fileService } from "../../services/awsBucket";
import { AccessServices } from "../../services/access";
import {
  NotificationCategory,
  NotificationMessageKey,
} from "../../utils/enums/enums";
import { translate } from "../../utils/i18n";

export class CommentRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const fullName = req.user.fullName;

      const {
        projectId,
        comment,
        postId,
        commentId,
        projectNoteId,
        fileUrl,
        fileSize,
        fileId,
        mentions,
        currentIndex,
      } = req.body;

      const obj: CommentType = { userId };

      if (fileUrl && fileUrl.trim != "") {
        obj.fileUrl = fileUrl;
        obj.fileSize = fileSize;
      }
      if (comment && comment.trim != "") {
        obj.comment = comment;
      }
      if (mentions && Array.isArray(mentions) && mentions.length > 0) {
        obj.mentions = mentions
          .filter((id: string) => isValidObjectId(id))
          .map((id: string) => ObjectId(id));
      }

      if (postId && isValidObjectId(postId)) {
        obj.postId = postId;
        if (fileId && isValidObjectId(fileId)) {
          obj.fileId = fileId;
        }
      } else if (projectId && isValidObjectId(projectId)) {
        obj.projectId = projectId;
      } else if (commentId && isValidObjectId(commentId)) {
        obj.commentId = commentId;
      } else if (projectNoteId && isValidObjectId(projectNoteId)) {
        obj.projectNoteId = projectNoteId;
      } else {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "please provide valid credentials",
        });
      }

      if (commentId && isValidObjectId(commentId)) {
        obj.commentId = commentId;
        delete obj.postId;
        delete obj.projectId;
        delete obj.projectNoteId;
        delete obj.fileId;
      }

      const createdComment = await CommentHelper.create(obj);

      const notifications = [];
      let projectName = "";

      if (
        postId &&
        isValidObjectId(postId) &&
        mentions &&
        mentions.length > 0
      ) {
        let url = config.APP_URL + `/Postscreen?postId=${postId}`;

        if (fileId && isValidObjectId(fileId)) {
          url += `&fileId=${fileId}`;
          if (currentIndex !== undefined && typeof currentIndex === "number") {
            url += `&currentIndex=${currentIndex}`;
          }
        }

        url += `&openComments=true&commentId=${createdComment._id}`;

        mentions.forEach((id) => {
          if (!isValidObjectId(id) || id.toString() == userId.toString())
            return;
          notifications.push({
            userId: id,
            message: translate(NotificationMessageKey.COMMENT_MENTION, {
              actor: fullName,
            }),
            messageKey: NotificationMessageKey.COMMENT_MENTION,
            messageParams: { actor: fullName },
            postId: postId,
            createdBy: userId,
            category: NotificationCategory.MENTION,
            url,
          });
        });
        const postInfo = await PostsHelper.getProjectNameByPostId(postId);
        projectName = postInfo[0].projectName;
      } else if (
        projectId &&
        isValidObjectId(projectId) &&
        mentions &&
        mentions.length > 0
      ) {
        const url =
          config.APP_URL +
          `/ProjectDetail?projectId=${projectId}&openComments=true&commentId=${createdComment._id}`;

        mentions.forEach((id) => {
          if (!isValidObjectId(id) || id.toString() == userId.toString())
            return;
          notifications.push({
            userId: id,
            message: translate(NotificationMessageKey.COMMENT_MENTION, {
              actor: fullName,
            }),
            messageKey: NotificationMessageKey.COMMENT_MENTION,
            messageParams: { actor: fullName },
            createdBy: userId,
            category: NotificationCategory.MENTION,
            url,
          });
        });
        const projectInfo = await ProjectHelper.getProjectData(projectId);
        projectName = projectInfo[0]?.name;
      }

      if (notifications.length) {
        await NotificationsHelpers.createAndSendNotfications(
          notifications,
          true,
          projectName,
        );
      }

      return SuccessResponse(res, status.OK, {
        message: "comment created succesfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getComments = async (
    req: AuthenticatedRequest & { query: PaginatedSearchQuery },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      let userId;
      if (req.headers?.authorization) {
        try {
          let authorizationHeader = req.headers.authorization;
          if (authorizationHeader.includes("Bearer")) {
            authorizationHeader = authorizationHeader.split(" ")[1];
          }
          const decoded = await verifyToken(authorizationHeader);
          userId = ObjectId(decoded.data._id);
        } catch (er) {
          /* empty */
        }
      }

      req.query.page = Number(req.query.page) || 1;
      req.query.limit = Number(req.query.pageSize) || 15;
      req.query.skips = (req.query.page - 1) * req.query.limit;

      const data = await CommentHelper.findAll(req.query, userId);

      if (data?.[0]?.items) {
        data[0].items = data[0].items.map((c) => {
          return {
            ...c,
            createdAt: getDaysDiff(c.createdAt, new Date()),
          };
        });
      }

      return SuccessResponse(res, status.OK, {
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateComment = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const userRoles = req.user.roles;
      const fullName = req.user.fullName;

      if (!id || !isValidObjectId(id)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "please provide valid commentId",
        });
      }

      const {
        projectId,
        comment,
        postId,
        commentId,
        projectNoteId,
        fileUrl,
        fileSize,
        fileId,
        mentions,
        currentIndex,
      } = req.body;

      const commentData = await CommentHelper.findById(id);

      if (
        !commentData ||
        !AccessServices.isSelfOrManagerOrAbove(
          userRoles,
          userId,
          commentData.userId,
        )
      ) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "you are not allowed to delete this comment",
        });
      }

      const updateObject: CommentType = { userId, mentions: [] };

      if (fileUrl && fileUrl.trim != "") {
        updateObject.fileUrl = fileUrl;
        updateObject.fileSize = fileSize;
      }
      if (comment && comment.trim != "") {
        updateObject.comment = comment;
      }
      if (mentions && Array.isArray(mentions) && mentions.length > 0) {
        updateObject.mentions = mentions
          .filter((id: string) => isValidObjectId(id))
          .map((id: string) => ObjectId(id));
      }

      if (postId && isValidObjectId(postId)) {
        updateObject.postId = postId;
        if (fileId && isValidObjectId(fileId)) {
          updateObject.fileId = fileId;
        }
      } else if (projectId && isValidObjectId(projectId)) {
        updateObject.projectId = projectId;
      } else if (commentId && isValidObjectId(commentId)) {
        updateObject.commentId = commentId;
      } else if (projectNoteId && isValidObjectId(projectNoteId)) {
        updateObject.projectNoteId = projectNoteId;
      } else {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "please provide valid credentials",
        });
      }

      if (commentId && isValidObjectId(commentId)) {
        updateObject.commentId = commentId;
        delete updateObject.postId;
        delete updateObject.projectId;
        delete updateObject.projectNoteId;
        delete updateObject.fileId;
      }

      await CommentHelper.update(id, updateObject);

      const notifications = [];
      let projectName = "";
      const previousMentions =
        commentData.mentions?.map((id) => id.toString()) || [];

      if (
        postId &&
        isValidObjectId(postId) &&
        mentions &&
        mentions.length > 0
      ) {
        let url = config.APP_URL + `/Postscreen?postId=${postId}`;

        if (fileId && isValidObjectId(fileId)) {
          url += `&fileId=${fileId}`;
          if (currentIndex !== undefined && typeof currentIndex === "number") {
            url += `&currentIndex=${currentIndex}`;
          }
        }

        // Auto-open the comment thread and scroll to the edited comment.
        url += `&openComments=true&commentId=${id}`;

        updateObject.mentions.forEach((id) => {
          if (
            id.toString() == userId.toString() ||
            previousMentions.includes(id.toString())
          )
            return;
          notifications.push({
            userId: id,
            message: translate(NotificationMessageKey.COMMENT_MENTION, {
              actor: fullName,
            }),
            messageKey: NotificationMessageKey.COMMENT_MENTION,
            messageParams: { actor: fullName },
            postId: postId,
            createdBy: userId,
            category: NotificationCategory.MENTION,
            url,
          });
        });
        const postInfo = await PostsHelper.getProjectNameByPostId(postId);
        projectName = postInfo[0].projectName;
      } else if (
        projectId &&
        isValidObjectId(projectId) &&
        mentions &&
        mentions.length > 0
      ) {
        const url =
          config.APP_URL +
          `/ProjectDetail?projectId=${projectId}&openComments=true&commentId=${id}`;

        updateObject.mentions.forEach((id) => {
          if (
            id.toString() == userId.toString() ||
            previousMentions.includes(id.toString())
          )
            return;
          notifications.push({
            userId: id,
            message: translate(NotificationMessageKey.COMMENT_MENTION, {
              actor: fullName,
            }),
            messageKey: NotificationMessageKey.COMMENT_MENTION,
            messageParams: { actor: fullName },
            createdBy: userId,
            category: NotificationCategory.MENTION,
            url,
          });
        });
        const projectInfo = await ProjectHelper.getProjectData(projectId);
        projectName = projectInfo[0]?.name;
      }

      if (notifications.length) {
        await NotificationsHelpers.createAndSendNotfications(
          notifications,
          true,
          projectName,
        );
      }

      return SuccessResponse(res, status.OK, {
        message: "comment updated succesfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteComment = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const userRoles = req.user.roles;

      if (!id || !isValidObjectId(id)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "please provide valid commentId",
        });
      }

      const comment = await CommentHelper.findById(id);

      if (!comment) {
        return SuccessResponse(res, status.OK, {
          message: "comment deleted successfully",
        });
      }

      // Check permissions
      if (
        !AccessServices.isSelfOrManagerOrAbove(
          userRoles,
          userId,
          comment.userId,
        )
      ) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "you are not allowed to delete this comment",
        });
      }

      const fileUrls: string[] = [];

      // Parallel operations: fetch child comments and prepare for deletion
      if (!comment.commentId) {
        // Parent comment - fetch and delete all replies
        const childComments = await CommentHelper.findAllReplies(comment._id);

        // Collect file URLs from child comments
        childComments.forEach((c) => {
          if (c.fileUrl) {
            fileUrls.push(c.fileUrl);
          }
        });

        // Delete parent comment, child comments, and S3 files in parallel
        if (comment.fileUrl) {
          fileUrls.push(comment.fileUrl);
        }

        await Promise.all([
          CommentHelper.deleteCommentById(id),
          CommentHelper.deleteRepliesByCommentId(comment._id),
          ...fileUrls.map((url) => fileService.deleteFromS3UsingLink(url)),
        ]);
      } else {
        // Child comment - just delete it and its file
        if (comment.fileUrl) {
          fileUrls.push(comment.fileUrl);
        }

        await Promise.all([
          CommentHelper.deleteCommentById(id),
          ...fileUrls.map((url) => fileService.deleteFromS3UsingLink(url)),
        ]);
      }

      return SuccessResponse(res, status.OK, {
        message: "comment deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
