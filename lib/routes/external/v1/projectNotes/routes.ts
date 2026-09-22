import * as express from "express";
import * as status from "http-status";
import { Validator } from "node-input-validator";

import {
  ErrorResponse,
  SuccessResponse,
} from "../../../../utils/helpers/apiResponse";
import { ApiKeyAuthenticatedRequest } from "../../../../middleware/apiKeyAuth";
import { ProjectNotesHelper } from "../../../projectNotes/helper";
import { ProjectHelper } from "../../../projects/helper";
import {
  IExternalProjectNoteCreateBody,
  IExternalProjectNoteUpdate,
  IExternalProjectNoteUpdateBody,
} from "../../../../utils/interfaces/externalApi";
import { ExternalApiHelper, MAX_FILES_PER_REQUEST } from "../helpers";
import { PendingUploadService } from "../../../../services/pendingUploads";

const MAX_NOTE_LENGTH = 10000;

export class ExternalProjectNotesRoutes {
  public static create = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectId: "required|mongoId",
        note: `required|string|minLength:1|maxLength:${MAX_NOTE_LENGTH}`,
        files: "array",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation failed",
          errors: validator.errors,
        });
      }

      const companyId = ExternalApiHelper.getCompanyId(req);
      if (!companyId) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "API key is not associated with a company",
        });
      }

      const body = req.body as IExternalProjectNoteCreateBody;

      const noteText = ExternalApiHelper.trimmedOrNull(body.note);
      if (!noteText) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "note must not be blank",
        });
      }

      const project = await ExternalApiHelper.findScopedProject(
        body.projectId,
        companyId,
      );

      if (!project) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project not found",
        });
      }

      const inputFiles = body.files ?? [];
      if (inputFiles.length > MAX_FILES_PER_REQUEST) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `files must contain at most ${MAX_FILES_PER_REQUEST} entries`,
        });
      }

      const normalized = ExternalApiHelper.normalizeNoteFiles(inputFiles);
      if (normalized.error) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: normalized.error,
        });
      }

      const note = await ProjectNotesHelper.create({
        projectId: project._id,
        userId: req.user._id,
        note: noteText,
        files: normalized.files,
      });

      await PendingUploadService.claim(normalized.files.map((f) => f.url));

      ProjectHelper.updateProjectInfo(project._id).catch((err) => {
        console.error("External API project touch error:", err);
      });

      return SuccessResponse(res, status.CREATED, {
        message: "project note created successfully",
        data: { projectNoteId: note._id, projectId: project._id },
      });
    } catch (error) {
      next(error);
    }
  };

  public static update = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectNoteId: "required|mongoId",
        note: `string|minLength:1|maxLength:${MAX_NOTE_LENGTH}`,
        files: "array",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation failed",
          errors: validator.errors,
        });
      }

      const companyId = ExternalApiHelper.getCompanyId(req);
      if (!companyId) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "API key is not associated with a company",
        });
      }

      const body = req.body as IExternalProjectNoteUpdateBody;
      const note = await ExternalApiHelper.findScopedNote(
        body.projectNoteId,
        companyId,
      );

      if (!note) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Note not found",
        });
      }

      // Same whitelist rule as projects: the internal helper $sets whatever it
      // is handed, so the patch is rebuilt field by field here.
      const update: IExternalProjectNoteUpdate = {};
      if (typeof body.note === "string") {
        const noteText = ExternalApiHelper.trimmedOrNull(body.note);
        if (!noteText) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "note must not be blank",
          });
        }
        update.note = noteText;
      }

      if (body.files !== undefined) {
        const inputFiles = body.files ?? [];
        if (inputFiles.length > MAX_FILES_PER_REQUEST) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `files must contain at most ${MAX_FILES_PER_REQUEST} entries`,
          });
        }
        const normalized = ExternalApiHelper.normalizeNoteFiles(inputFiles);
        if (normalized.error) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: normalized.error,
          });
        }
        update.files = normalized.files;
      }

      if (!Object.keys(update).length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "no updatable fields supplied",
        });
      }

      await ProjectNotesHelper.put({
        projectNoteId: body.projectNoteId,
        update,
      });

      if (update.files?.length) {
        await PendingUploadService.claim(update.files.map((f) => f.url));
      }

      return SuccessResponse(res, status.OK, {
        message: "project note updated successfully",
        data: { projectNoteId: note._id },
      });
    } catch (error) {
      next(error);
    }
  };

  public static delete = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectNoteId: "required|mongoId",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation failed",
          errors: validator.errors,
        });
      }

      const companyId = ExternalApiHelper.getCompanyId(req);
      if (!companyId) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "API key is not associated with a company",
        });
      }

      const projectNoteId = String(req.query.projectNoteId);
      const note = await ExternalApiHelper.findScopedNote(
        projectNoteId,
        companyId,
      );

      if (!note) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Note not found",
        });
      }

      await ProjectNotesHelper.delete(projectNoteId);

      return SuccessResponse(res, status.OK, {
        message: "project note deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
