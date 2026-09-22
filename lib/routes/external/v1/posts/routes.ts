import * as express from "express";
import * as status from "http-status";
import { Validator } from "node-input-validator";

import {
  ErrorResponse,
  SuccessResponse,
} from "../../../../utils/helpers/apiResponse";
import { ApiKeyAuthenticatedRequest } from "../../../../middleware/apiKeyAuth";
import { PostsHelper } from "../../../posts/helper";
import { PostsRoutes } from "../../../posts/routes";
import { ProjectHelper } from "../../../projects/helper";
import { onPostCreated } from "../../../../integrations/hooks";
import {
  IExternalPostCreateBody,
  IExternalPostFilesBody,
} from "../../../../utils/interfaces/externalApi";
import { ExternalApiHelper, MAX_FILES_PER_REQUEST } from "../helpers";
import { PendingUploadService } from "../../../../services/pendingUploads";

const MAX_NOTE_LENGTH = 5000;

export class ExternalPostRoutes {
  /**
   * Creates a post with its photos/videos already in S3. Callers get the object
   * keys from the /v1/uploads endpoints and pass them back here as file urls —
   * bytes never pass through this handler.
   */
  public static create = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectId: "required|mongoId",
        note: `string|maxLength:${MAX_NOTE_LENGTH}`,
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

      const body = req.body as IExternalPostCreateBody;
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

      const normalized = await ExternalApiHelper.normalizePostFiles(
        inputFiles,
        companyId,
      );
      if (normalized.error) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: normalized.error,
        });
      }

      const post = await PostsHelper.create(
        req.user._id,
        {
          projectId: project._id,
          note: body.note,
          files: normalized.files,
        },
        project.companyId,
      );

      // Mark the uploaded objects as in use so the orphan sweep leaves them.
      await PendingUploadService.claim(normalized.files.map((f) => f.url));

      ProjectHelper.updateProjectInfo(project._id).catch((err) => {
        console.error("External API project touch error:", err);
      });
      PostsRoutes.invokeNotication(post, {
        _id: req.user._id,
        fullName: req.user.fullName,
      }).catch((err) => {
        console.error("External API post notification error:", err);
      });

      // Outbound CRM sync, deliberately not awaited.
      onPostCreated(post, req.user).catch((err) => {
        console.error("External API post create hook error:", err);
      });

      return SuccessResponse(res, status.CREATED, {
        message: "post created successfully",
        data: {
          postId: post._id,
          projectId: project._id,
          fileIds: (post.files ?? []).map((file) => file._id),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  // Appends more media to a post that already exists, keeping the batch at the
  // end of the post's ordering.
  public static insertFiles = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        postId: "required|mongoId",
        files: "required|array",
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

      const body = req.body as IExternalPostFilesBody;
      const inputFiles = body.files ?? [];

      if (!inputFiles.length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "files must be a non-empty array",
        });
      }
      if (inputFiles.length > MAX_FILES_PER_REQUEST) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `files must contain at most ${MAX_FILES_PER_REQUEST} entries`,
        });
      }

      const post = await ExternalApiHelper.findScopedPost(
        body.postId,
        companyId,
      );

      if (!post) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      const normalized = await ExternalApiHelper.normalizePostFiles(
        inputFiles,
        companyId,
      );
      if (normalized.error) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: normalized.error,
        });
      }

      const result = await PostsHelper.insertFilesInPost(
        body.postId,
        normalized.files,
      );

      await PendingUploadService.claim(normalized.files.map((f) => f.url));

      ProjectHelper.updateProjectInfo(post.projectId).catch((err) => {
        console.error("External API project touch error:", err);
      });

      return SuccessResponse(res, status.OK, {
        message: "files added successfully",
        data: { postId: post._id, insertedCount: result?.insertedCount ?? 0 },
      });
    } catch (error) {
      next(error);
    }
  };
}
