import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { Response, NextFunction } from "express";
import { ReportsHelpers } from "./helpers";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import * as status from "http-status";
import { convertTime } from "../../utils/helpers/commonHelper";
import { Validator } from "node-input-validator";
import { isValidObjectId } from "mongoose";
import { PostsHelper } from "../posts/helper";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
import { CompanyHelpers } from "../company/helpers";
import { CommentHelper } from "../comments/helper";
import { fileService } from "../../services/awsBucket";
import { ProjectHelper } from "../projects/helper";
import { USER_ROLE } from "../../utils/enums/enums";
import { PostFiles } from "../../db";
import { config } from "../../utils/configuration/config";

export class ReportsRoutes {
  public static getReports = async (
    req: AuthenticatedRequest & { query: PaginatedSearchQuery },
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const query = req.query;
      query.page = Number(query.page) || 1;
      query.limit = Number(query.pageSize) || 50;
      query.skips = (query.page - 1) * query.limit;

      const data = await ReportsHelpers.getReports(req.user._id, query);
      if (data?.[0]?.items) {
        data[0].items = data[0].items.map((d) => ({
          ...d,
          createdAt: convertTime(d.createdAt),
          url: config.APP_URL + "/ReportedPost?postId=" + d._id.toString(),
        }));
      }
      return SuccessResponse(res, status.OK, {
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static readReport = async (
    req: AuthenticatedRequest & { query: { postId: string } },
    res: Response,
    next: NextFunction,
  ) => {
    try {
      //validating body
      const validator = new Validator(req.query, {
        postId: "string|required",
      });

      const matched = await validator.check();
      const { postId } = req.query;

      if (!matched || !isValidObjectId(postId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Enter valid PostId",
          errors: "Enter valid PostId",
        });
      }

      await ReportsHelpers.markAsRead(postId);

      return SuccessResponse(res, status.OK, {
        message: "updated successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getReportData = async (
    req: AuthenticatedRequest & { query: { postId: string } },
    res: Response,
    next: NextFunction,
  ) => {
    try {
      //validating body
      const validator = new Validator(req.query, {
        postId: "string|required",
      });

      const matched = await validator.check();
      const { postId } = req.query;

      if (!matched || !isValidObjectId(postId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Enter valid PostId",
          errors: "Enter valid PostId",
        });
      }

      const data = await ReportsHelpers.getReportData(postId);

      if (data?.[0]?.reportReasons) {
        data[0].reportReasons = data[0].reportReasons.map((d) => ({
          ...d,
          createdAt: convertTime(d.createdAt),
        }));
        data[0].createdAt = convertTime(data[0].createdAt);
      }
      return SuccessResponse(res, status.OK, {
        data: data[0],
      });
    } catch (error) {
      next(error);
    }
  };

  public static deletePost = async (
    req: AuthenticatedRequest & { body: { postId: string } },
    res: Response,
    next: NextFunction,
  ) => {
    try {
      //validating body
      const validator = new Validator(req.body, {
        postId: "string|required",
      });

      const matched = await validator.check();

      const { postId } = req.body;

      if (!matched || !isValidObjectId(postId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Enter valid PostId",
          errors: "Enter valid PostId",
        });
      }

      const postData = await PostsHelper.getPostInfo(postId);
      const postOwnerId = postData.userId;

      if (!postData?._id) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      if (
        postOwnerId.toString() !== req.user._id.toString() &&
        req.user?.companies?.[0]?.role !== USER_ROLE.MANAGER
      ) {
        const companyData = await ProjectHelper.getCompanyId(
          postData.projectId,
        );
        const companyAdmin = await CompanyHelpers.getCompanyAdminId(
          companyData.companyId,
        );
        const userRole = await CompanyHelpers.getCompanyMemberRole(
          companyData.companyId,
          req.user._id,
        );
        if (
          !(
            req.user._id.toString() === companyAdmin.userId.toString() ||
            userRole?.role === USER_ROLE.MANAGER
          )
        ) {
          return ErrorResponse(res, status.FORBIDDEN, {
            message: "Unauthorized to update this post",
          });
        }
      }

      await PostsHelper.deletePost(postId);
      await ReportsHelpers.deleteReport(postId);

      SuccessResponse(res, status.OK, {
        message: "Post deletion initiated",
      });

      (async () => {
        const postFiles = await PostFiles.find(
          { postId: postData._id },
          { _id: 1 },
        ).lean();
        const query = {
          fileId: { $in: postFiles.map((file) => file._id) },
        };
        const images = await CommentHelper.getCommentsWithFiles(query);

        await Promise.all([
          CommentHelper.deleteCommentsByFileId(query),
          Promise.all(
            images.map((file) => {
              if (!file.fileUrl) return;
              return fileService.deleteFromS3UsingLink(file.fileUrl);
            }),
          ),
        ]);
      })().catch();
    } catch (error) {
      next(error);
    }
  };

  public static ingorePost = async (
    req: AuthenticatedRequest & { body: { postId: string } },
    res: Response,
    next: NextFunction,
  ) => {
    try {
      //validating body
      const validator = new Validator(req.body, {
        postId: "string|required",
      });

      const matched = await validator.check();
      const { postId } = req.body;

      if (!matched || !isValidObjectId(postId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Enter valid PostId",
          errors: "Enter valid PostId",
        });
      }

      await ReportsHelpers.deleteReport(postId);

      return SuccessResponse(res, status.OK, {
        message: "Report ignored successfully",
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
      const user = req.user;
      await ReportsHelpers.markAllAsRead(user._id);
      return SuccessResponse(res, status.OK, {
        message: "All reports marked as read",
      });
    } catch (error) {
      next(error);
    }
  };
}
