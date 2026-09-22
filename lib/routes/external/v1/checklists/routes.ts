import * as express from "express";
import * as status from "http-status";
import { Validator } from "node-input-validator";

import {
  ErrorResponse,
  SuccessResponse,
} from "../../../../utils/helpers/apiResponse";
import { ApiKeyAuthenticatedRequest } from "../../../../middleware/apiKeyAuth";
import { ChecklistHelper } from "../../../checklist/helper";
import { ProjectHelper } from "../../../projects/helper";
import { CHECKLIST_TYPE } from "../../../../utils/enums/checklist";
import { validateFieldDefinition } from "../../../../utils/helpers/checklistFields";
import {
  FieldDefinitionType,
  TaskV2PayloadType,
} from "../../../../utils/interfaces/schemaInterface";
import {
  IExternalChecklistCreateBody,
  IExternalChecklistPhotoOutput,
  IExternalChecklistTaskInput,
} from "../../../../utils/interfaces/externalApi";
import { ExternalApiHelper, MAX_FILES_PER_REQUEST } from "../helpers";
import { PendingUploadService } from "../../../../services/pendingUploads";

const MAX_NAME_LENGTH = 200;
const MAX_TASK_NAME_LENGTH = 500;
const MAX_TASK_DESCRIPTION_LENGTH = 5000;
const MAX_TASKS_PER_CHECKLIST = 200;
const MAX_FIELDS_PER_TASK = 100;
const MAX_CONTRIBUTORS = 100;

interface INormalizedTasks {
  tasks?: TaskV2PayloadType[];
  photoUrls?: string[];
  error?: string;
}

/**
 * Checklist creation for the external API.
 *
 * Only the V2 (typed-field) shape is exposed. The legacy `todoList`/`questions`
 * payload is still accepted internally, but offering both over a public API
 * would mean two competing task models and two validation paths; V2 is the one
 * the apps write today and the only one with a shared field validator.
 */
export class ExternalChecklistRoutes {
  public static create = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectId: "required|mongoId",
        name: `required|string|minLength:1|maxLength:${MAX_NAME_LENGTH}`,
        type: `string|in:${Object.values(CHECKLIST_TYPE).join(",")}`,
        contributors: "array",
        tasks: "array",
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

      const body = req.body as IExternalChecklistCreateBody;

      const name = ExternalApiHelper.trimmedOrNull(body.name);
      if (!name) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "name must not be blank",
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

      const contributorIds = body.contributors ?? [];
      if (contributorIds.length > MAX_CONTRIBUTORS) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `at most ${MAX_CONTRIBUTORS} contributors`,
        });
      }

      const contributors = await ExternalApiHelper.resolveCompanyMembers(
        contributorIds.map(String),
        companyId,
      );
      if (!contributors) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "contributors must be active members of this company",
        });
      }

      const normalized = ExternalChecklistRoutes.normalizeTasks(body.tasks);
      if (normalized.error) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: normalized.error,
        });
      }

      const checklistId = await ChecklistHelper.createV2(
        req.user._id,
        {
          name,
          projectId: project._id,
          companyId: project.companyId,
          contributors,
          tasks: normalized.tasks,
        },
        body.type ?? CHECKLIST_TYPE.CHECKLIST,
      );

      if (normalized.photoUrls?.length) {
        await PendingUploadService.claim(normalized.photoUrls);
      }

      ProjectHelper.updateProjectInfo(project._id).catch((err) => {
        console.error("External API project touch error:", err);
      });

      return SuccessResponse(res, status.CREATED, {
        message: "checklist created successfully",
        data: { checklistId, projectId: project._id },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Whitelists the task payload and validates every field definition through
   * the shared `validateFieldDefinition`, which is the same code the apps and
   * the internal V2 endpoint are checked against.
   *
   * Unlike the internal handler, blank-named tasks are rejected rather than
   * silently dropped — an integrator sending one has a bug, and quietly
   * discarding part of a checklist is worse than a 422.
   */
  private static normalizeTasks = (
    tasks?: IExternalChecklistTaskInput[],
  ): INormalizedTasks => {
    if (tasks === undefined) return { tasks: [], photoUrls: [] };
    if (!Array.isArray(tasks)) return { error: "tasks must be an array" };
    if (tasks.length > MAX_TASKS_PER_CHECKLIST) {
      return {
        error: `at most ${MAX_TASKS_PER_CHECKLIST} tasks per checklist`,
      };
    }

    const normalized: TaskV2PayloadType[] = [];
    const photoUrls: string[] = [];

    for (let t = 0; t < tasks.length; t++) {
      const task = tasks[t];

      if (!task || typeof task !== "object") {
        return { error: `tasks[${t}] must be an object` };
      }
      if (typeof task.name !== "string" || !task.name.trim()) {
        return { error: `tasks[${t}].name is required` };
      }
      if (task.name.length > MAX_TASK_NAME_LENGTH) {
        return {
          error: `tasks[${t}].name must be at most ${MAX_TASK_NAME_LENGTH} chars`,
        };
      }
      if (
        task.description !== undefined &&
        (typeof task.description !== "string" ||
          task.description.length > MAX_TASK_DESCRIPTION_LENGTH)
      ) {
        return {
          error: `tasks[${t}].description must be a string of at most ${MAX_TASK_DESCRIPTION_LENGTH} chars`,
        };
      }

      const fieldsResult = ExternalChecklistRoutes.normalizeFields(task, t);
      if (fieldsResult.error) return { error: fieldsResult.error };

      const photosResult = ExternalChecklistRoutes.normalizePhotos(task, t);
      if (photosResult.error) return { error: photosResult.error };
      photoUrls.push(...(photosResult.urls ?? []));

      normalized.push({
        name: task.name.trim(),
        description: task.description,
        sortOrder:
          typeof task.sortOrder === "number" && Number.isFinite(task.sortOrder)
            ? task.sortOrder
            : t,
        photosRequired: task.photosRequired === true,
        fields: fieldsResult.fields,
        taskImages: photosResult.photos,
      });
    }

    return { tasks: normalized, photoUrls };
  };

  private static normalizeFields = (
    task: IExternalChecklistTaskInput,
    index: number,
  ): { fields?: FieldDefinitionType[]; error?: string } => {
    if (task.fields === undefined) return { fields: [] };
    if (!Array.isArray(task.fields)) {
      return { error: `tasks[${index}].fields must be an array` };
    }
    if (task.fields.length > MAX_FIELDS_PER_TASK) {
      return {
        error: `tasks[${index}].fields must have at most ${MAX_FIELDS_PER_TASK} entries`,
      };
    }

    const fields: FieldDefinitionType[] = [];

    for (let f = 0; f < task.fields.length; f++) {
      const field = task.fields[f] as FieldDefinitionType;
      const error = validateFieldDefinition(field);
      if (error) {
        return { error: `tasks[${index}].fields[${f}]: ${error}` };
      }
      // config is persisted as Mixed; buildFields strips it to the keys
      // meaningful for the field type.
      fields.push({
        fieldType: field.fieldType,
        label: field.label,
        required: field.required,
        sortOrder: field.sortOrder ?? f,
        config: field.config,
      });
    }

    return { fields };
  };

  private static normalizePhotos = (
    task: IExternalChecklistTaskInput,
    index: number,
  ): {
    photos?: IExternalChecklistPhotoOutput[];
    urls?: string[];
    error?: string;
  } => {
    if (task.taskImages === undefined) return { photos: undefined, urls: [] };
    if (!Array.isArray(task.taskImages)) {
      return { error: `tasks[${index}].taskImages must be an array` };
    }
    if (task.taskImages.length > MAX_FILES_PER_REQUEST) {
      return {
        error: `tasks[${index}].taskImages must have at most ${MAX_FILES_PER_REQUEST} entries`,
      };
    }

    const photos: IExternalChecklistPhotoOutput[] = [];
    const urls: string[] = [];

    for (let i = 0; i < task.taskImages.length; i++) {
      const image = task.taskImages[i]?.imageData;
      const path = `tasks[${index}].taskImages[${i}].imageData`;

      if (!image || typeof image !== "object") {
        return { error: `${path} is required` };
      }
      if (typeof image.url !== "string" || !image.url.trim()) {
        return { error: `${path}.url is required` };
      }
      if (typeof image.fileType !== "string" || !image.fileType.trim()) {
        return { error: `${path}.fileType is required` };
      }

      // Dimensions are required here (unlike post files): the checklist task
      // payload treats them as mandatory, and the apps use them to lay out the
      // task's photo strip.
      const width = Number(image.size?.width);
      const height = Number(image.size?.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return {
          error: `${path}.size must be { width, height } in pixels`,
        };
      }

      urls.push(image.url.trim());
      photos.push({
        imageData: {
          url: image.url.trim(),
          fileType: image.fileType.trim(),
          size: { width, height },
        },
      });
    }

    return { photos, urls };
  };
}
