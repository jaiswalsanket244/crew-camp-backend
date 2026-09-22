import * as express from "express";
import * as status from "http-status";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { ProjectNotesHelper, projectNotesQuery } from "./helper";
import { convertTime, ObjectId } from "../../utils/helpers/commonHelper";
import { Validator } from "node-input-validator";
import { ProjectHelper } from "../projects/helper";

export class ProjectNotesRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { note, projectId, files } = req.body;

      const obj = {
        note,
        projectId,
        userId: req.user._id,
        files,
      };

      await ProjectNotesHelper.create(obj);
      ProjectHelper.updateProjectInfo(projectId);

      return SuccessResponse(res, status.OK, {
        message: "project notes created succesfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getMyProjectNotes = async (
    req: AuthenticatedRequest & { query: projectNotesQuery },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      req.query.page = Number(req.query.page) || 1;
      req.query.limit = Number(req.query.pageSize) || 15;
      req.query.skips = (req.query.page - 1) * req.query.limit;

      const data = await ProjectNotesHelper.findAll(req.query);

      if (data?.[0]?.items) {
        data[0].items = data[0].items.map((d) => ({
          ...d,
          createdAt: convertTime(d.createdAt),
        }));
      }

      return SuccessResponse(res, status.OK, {
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteNote = async (
    req: AuthenticatedRequest & { query: { projectNoteId: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectNoteId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      await ProjectNotesHelper.delete(req.query.projectNoteId);

      return SuccessResponse(res, status.OK, {
        message: "note deleted successfully",
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
        projectNoteId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      await ProjectNotesHelper.put(req.body);

      return SuccessResponse(res, status.OK, {
        message: "note deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getNotesByProjectId = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;

      const validator = new Validator(req.query, {
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const isPartOfProject = await ProjectHelper.checkIfPartOfProject(
        ObjectId(req.query.projectId),
        userId,
      );

      if (!isPartOfProject) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Data Not found",
        });
      }

      req.query.page = Number(req.query.page) || 1;
      req.query.limit = Number(req.query.pageSize) || 15;
      req.query.skips = (req.query.page - 1) * req.query.limit;

      const data = await ProjectNotesHelper.findAll(req.query);

      if (data?.[0]?.items) {
        data[0].items = data[0].items.map((d) => ({
          ...d,
          createdAt: convertTime(d.createdAt),
        }));
      }

      return SuccessResponse(res, status.OK, {
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
