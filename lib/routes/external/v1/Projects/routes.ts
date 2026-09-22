import * as express from "express";
import * as status from "http-status";
import { Validator } from "node-input-validator";

import {
  ErrorResponse,
  SuccessResponse,
} from "../../../../utils/helpers/apiResponse";
import { ApiKeyAuthenticatedRequest } from "../../../../middleware/apiKeyAuth";
import { ProjectHelper } from "../../../projects/helper";
import {
  onProjectCreated,
  onProjectUpdated,
} from "../../../../integrations/hooks";
import { isStandardAndAbove } from "../../../../utils/helpers/users";
import {
  IExternalCoordinates,
  IExternalProjectCreateBody,
  IExternalProjectUpdate,
  IExternalProjectUpdateBody,
} from "../../../../utils/interfaces/externalApi";
import { ExternalApiHelper, MAX_TAGS_PER_REQUEST } from "../helpers";
import { PendingUploadService } from "../../../../services/pendingUploads";

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_LOCATION_LENGTH = 500;

// Returns the coordinates to persist, or an error string when the pair is
// present but unusable. `undefined` on both means "not supplied".
const parseCoordinates = (
  coordinates?: IExternalCoordinates,
): { value?: IExternalCoordinates; error?: string } => {
  if (coordinates === undefined) return {};
  if (!coordinates || typeof coordinates !== "object") {
    return { error: "coordinates must be an object" };
  }

  const latitude = Number(coordinates.latitude);
  const longitude = Number(coordinates.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      error: "coordinates.latitude and coordinates.longitude must be numbers",
    };
  }
  if (latitude < -90 || latitude > 90) {
    return { error: "coordinates.latitude must be between -90 and 90" };
  }
  if (longitude < -180 || longitude > 180) {
    return { error: "coordinates.longitude must be between -180 and 180" };
  }

  return { value: { latitude, longitude } };
};

export class ExternalProjectRoutes {
  public static create = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        name: `required|string|minLength:1|maxLength:${MAX_NAME_LENGTH}`,
        description: `string|maxLength:${MAX_DESCRIPTION_LENGTH}`,
        location: `string|maxLength:${MAX_LOCATION_LENGTH}`,
        projectImage: "string",
        coordinates: "object",
        tags: "array",
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

      const actorRole = await ExternalApiHelper.getActorRole(req);
      if (!isStandardAndAbove(actorRole)) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "this API key is not authorized to create projects",
        });
      }

      const body = req.body as IExternalProjectCreateBody;

      const name = ExternalApiHelper.trimmedOrNull(body.name);
      if (!name) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "name must not be blank",
        });
      }

      const coordinates = parseCoordinates(body.coordinates);
      if (coordinates.error) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: coordinates.error,
        });
      }

      const tags = await ExternalApiHelper.resolveTags(
        body.tags ?? [],
        companyId,
      );
      if (!tags) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `tags must be at most ${MAX_TAGS_PER_REQUEST} ids that exist for this company`,
        });
      }

      const project = await ProjectHelper.createByPayLoad({
        companyId,
        userId: req.user._id,
        name,
        description: body.description,
        location: body.location,
        projectImage: body.projectImage,
        coordinates: coordinates.value,
        tags,
      });

      await ProjectHelper.addToProject(project._id, req.user._id);

      if (body.projectImage) {
        await PendingUploadService.claim([body.projectImage]);
      }

      // Outbound CRM sync, deliberately not awaited — a slow provider must not
      // hold up the API response.
      onProjectCreated(project._id).catch((err) => {
        console.error("External API project create hook error:", err);
      });

      return SuccessResponse(res, status.CREATED, {
        message: "project created successfully",
        data: {
          projectId: project._id,
          name: project.name,
          description: project.description,
          location: project.location,
        },
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
        projectId: "required|mongoId",
        name: `string|minLength:1|maxLength:${MAX_NAME_LENGTH}`,
        description: `string|maxLength:${MAX_DESCRIPTION_LENGTH}`,
        location: `string|maxLength:${MAX_LOCATION_LENGTH}`,
        projectImage: "string",
        coordinates: "object",
        tags: "array",
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

      const body = req.body as IExternalProjectUpdateBody;
      const project = await ExternalApiHelper.findScopedProject(
        body.projectId,
        companyId,
      );

      if (!project) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project not found",
        });
      }

      // Whitelist: the internal update path $sets whatever it is given, so the
      // external one builds the patch field by field instead of forwarding req.body.
      const update: IExternalProjectUpdate = {};
      if (typeof body.name === "string") {
        const name = ExternalApiHelper.trimmedOrNull(body.name);
        if (!name) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "name must not be blank",
          });
        }
        update.name = name;
      }
      if (typeof body.description === "string") {
        update.description = body.description;
      }
      if (typeof body.location === "string") update.location = body.location;
      if (typeof body.projectImage === "string") {
        update.projectImage = body.projectImage;
      }

      if (body.coordinates !== undefined) {
        const coordinates = parseCoordinates(body.coordinates);
        if (coordinates.error) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: coordinates.error,
          });
        }
        update.coordinates = coordinates.value;
      }

      if (body.tags !== undefined) {
        const tags = await ExternalApiHelper.resolveTags(
          body.tags ?? [],
          companyId,
        );
        if (!tags) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `tags must be at most ${MAX_TAGS_PER_REQUEST} ids that exist for this company`,
          });
        }
        update.tags = tags;
      }

      if (!Object.keys(update).length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "no updatable fields supplied",
        });
      }

      await ProjectHelper.put({ projectId: body.projectId, update });

      if (update.projectImage) {
        await PendingUploadService.claim([update.projectImage]);
      }

      onProjectUpdated(body.projectId).catch((err) => {
        console.error("External API project update hook error:", err);
      });

      return SuccessResponse(res, status.OK, {
        message: "project updated successfully",
        data: { projectId: project._id },
      });
    } catch (error) {
      next(error);
    }
  };
}
