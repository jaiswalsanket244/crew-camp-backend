import * as express from "express";
import * as httpStatus from "http-status";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { PostsHelper } from "../posts/helper";
import { ProjectHelper } from "../projects/helper";
import { ProjectTasksHelper } from "../projectTasks/helper";
import { Validator } from "node-input-validator";
import { isValidObjectId } from "mongoose";
import { ChecklistHelper } from "../checklist/helper";
import { ProjectReportsHelpers } from "../projectReport/helpers";
import { FilesHelper } from "../file/helper";
import { PostService } from "../../services/posts";
import { TasksService } from "../../services/tasks";
import { ChecklistsServices } from "../../services/checklists";
import { ProjectReportServices } from "../../services/projectReport";
import { ObjectId } from "../../utils/helpers/commonHelper";
import { FilesService } from "../../services/files";
import { ProjectService } from "../../services/projects";
import { getActiveAdminCompanies } from "../../utils/helpers/commonHelper";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";

export class BinRoutes {
  /**
   * GET /bin/projects — projects this admin can restore, newest first.
   * Scoped to the companies where the user has admin/manager access, matching
   * the guard on delete: seeing a binned project implies being able to act on it.
   */
  public static getProjects = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const managedCompanyIds = getActiveAdminCompanies(req.user?.companies);

      if (!managedCompanyIds.length) {
        return SuccessResponse(res, httpStatus.OK, { data: [] });
      }

      const data = await ProjectHelper.getDeletedProjects(managedCompanyIds);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /bin/projects — restore a binned project and everything binned with it.
   */
  public static revertDeletedProject = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const guard = await BinRoutes.authorizeBinnedProject(req, res);
      if (!guard) return;

      const restored = await ProjectService.restoreProject(guard.projectId);

      return SuccessResponse(res, httpStatus.OK, {
        message: "project restored successfully",
        data: { projectId: guard.projectId, restored },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /bin/projects — purge now, without waiting out the retention window.
   * Irreversible: removes every row and every S3 object under the project.
   */
  public static deleteProjectPermanently = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const guard = await BinRoutes.authorizeBinnedProject(req, res);
      if (!guard) return;

      await ProjectService.purgeProject(guard.projectId);

      return SuccessResponse(res, httpStatus.OK, {
        message: "project deleted permanently",
        data: { projectId: guard.projectId },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Shared guard for the two bin actions: validates the id, confirms the project
   * is actually in the bin, and confirms the caller administers its company.
   * Writes the error response itself and returns null when any check fails.
   */
  private static authorizeBinnedProject = async (
    req: AuthenticatedRequest,
    res: express.Response,
  ): Promise<{ projectId: ObjectIdType } | null> => {
    const validator = new Validator(req.body, {
      projectId: "required|string",
    });

    if (!(await validator.check())) {
      ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
        message: validator.errors,
        errors: validator.errors,
      });
      return null;
    }

    const { projectId } = req.body;
    if (!isValidObjectId(projectId)) {
      ErrorResponse(res, httpStatus.BAD_REQUEST, {
        message: "Invalid projectId",
      });
      return null;
    }

    const project = await ProjectHelper.getProjectForDelete(
      ObjectId(projectId),
    );
    if (!project) {
      ErrorResponse(res, httpStatus.NOT_FOUND, {
        message: "Project not found",
      });
      return null;
    }

    const managedCompanyIds = getActiveAdminCompanies(req.user?.companies).map(
      (companyId) => companyId.toString(),
    );

    if (!managedCompanyIds.includes(project.companyId?.toString())) {
      ErrorResponse(res, httpStatus.FORBIDDEN, {
        message: "you are not authorized to manage this project",
      });
      return null;
    }

    if (project.status !== CURRENT_STATUS.DELETED) {
      ErrorResponse(res, httpStatus.BAD_REQUEST, {
        message: "this project is not in the bin",
      });
      return null;
    }

    return { projectId: ObjectId(projectId) };
  };

  public static getPosts = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const data = await PostsHelper.getDeletedposts(userId);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static revertDeletedPost = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        postId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { postId } = req.body;
      if (!isValidObjectId(postId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid postId",
        });
      }

      const data = await PostsHelper.revertDeletePost(postId);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static deletePostPermanently = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        postId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { postId } = req.body;
      if (!isValidObjectId(postId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid postId",
        });
      }

      await PostService.deletePostsById(ObjectId(postId));

      return SuccessResponse(res, httpStatus.OK, {
        message: "Post deleted permanently",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getTasks = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const projectIds = await ProjectHelper.getMyProjects(userId);

      const data = await ProjectTasksHelper.getDeletedTasks(projectIds);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static revertDeletedTask = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        taskId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { taskId } = req.body;
      if (!isValidObjectId(taskId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid taskId",
        });
      }

      const data = await ProjectTasksHelper.restoreDeletedTask(
        ObjectId(taskId),
      );

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static deleteTaskPermanently = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        taskId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { taskId } = req.body;
      if (!isValidObjectId(taskId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid taskId",
        });
      }

      await TasksService.deleteTaskById(ObjectId(taskId));

      return SuccessResponse(res, httpStatus.OK, {
        message: "Task deleted permanently",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getDeletedChecklists = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const companyId = req.user.companyId;

      const data = await ChecklistHelper.getDeletedChecklists(companyId);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static revertDeletedChecklist = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        checklistId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { checklistId } = req.body;
      if (!isValidObjectId(checklistId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid checklistId",
        });
      }

      const data = await ChecklistHelper.restoreDeletedChecklist(checklistId);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static deleteChecklistPermanently = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        checklistId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { checklistId } = req.body;
      if (!isValidObjectId(checklistId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid checklistId",
        });
      }

      await ChecklistsServices.deleteChecklistById(ObjectId(checklistId));
      return SuccessResponse(res, httpStatus.OK, {
        message: "Checklist deleted permanently",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getDeletedReports = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const companyId = req.user.companyId;

      const data = await ProjectReportsHelpers.getDeletedReports(companyId);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static revertDeletedReport = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        reportId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { reportId } = req.body;
      if (!isValidObjectId(reportId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid reportId",
        });
      }

      const data = await ProjectReportsHelpers.restoreDeletedReport(reportId);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static deleteReportPermanently = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        reportId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { reportId } = req.body;
      if (!isValidObjectId(reportId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid reportId",
        });
      }

      await ProjectReportServices.deleteReportById(ObjectId(reportId));
      return SuccessResponse(res, httpStatus.OK, {
        message: "Report deleted permanently",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getDeletedFiles = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const companyId = req.user.companyId;
      const userId = req.user._id;
      const userRole = req.user?.companies?.[0]?.role;

      const data = await FilesHelper.getDeletedFiles(
        companyId,
        userId,
        userRole,
      );

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static revertDeletedFile = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        fileId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { fileId } = req.body;
      if (!isValidObjectId(fileId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid fileId",
        });
      }

      const data = await FilesHelper.restoreDeletedFile(fileId);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static deleteFilesPermanently = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        fileId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { fileId } = req.body;
      if (!isValidObjectId(fileId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid fileId",
        });
      }

      await FilesService.deleteFileById(ObjectId(fileId));
      return SuccessResponse(res, httpStatus.OK, {
        message: "File deleted permanently",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getDeletedPostFiles = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;

      const data = await PostsHelper.getDeletedPostFiles(userId);

      return SuccessResponse(res, httpStatus.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  public static revertDeletedPostFile = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        deletedFileId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { deletedFileId } = req.body;
      if (!isValidObjectId(deletedFileId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid deletedFileId",
        });
      }

      await PostsHelper.restorePostFile(ObjectId(deletedFileId));

      return SuccessResponse(res, httpStatus.OK, {
        message: "Post file restored successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static deletePostFilesPermanently = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        deletedFileId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { deletedFileId } = req.body;
      if (!isValidObjectId(deletedFileId)) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Invalid deletedFileId",
        });
      }

      await PostService.deletePostFileById(ObjectId(deletedFileId));

      return SuccessResponse(res, httpStatus.OK, {
        message: "Post file deleted permanently",
      });
    } catch (error) {
      next(error);
    }
  };
}
