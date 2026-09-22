// NPM Dependencies
import * as status from "http-status";
import * as express from "express";
import { Validator } from "node-input-validator";

// Internal Dependencies
import { AiProjectUpdateHelpers, IPostFileRef } from "./helpers";
import { normalizeUpdateListPaging, updateListPagination } from "./listQuery";
import {
  hasUsableText,
  isValidTimeZone,
  normalizeGeneratePhotos,
  validateDateRange,
  validateFileIds,
  validateRichTextDoc,
  validateTitle,
} from "./validate";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { isValidObjectId, ObjectId } from "../../utils/helpers/commonHelper";
import {
  DAILY_LOG_LANGUAGES,
  toDailyLogLanguage,
} from "../../utils/enums/dailyLog";
import {
  AI_PROJECT_UPDATE_GENERATE_MAX_BYTES,
  AI_PROJECT_UPDATE_SCHEMA_VERSION,
} from "../../utils/enums/aiProjectUpdate";
import {
  IAiProjectUpdateDocument,
  IAiProjectUpdateGeneration,
  IAiProjectUpdateInput,
  IAiProjectUpdatePhoto,
} from "../../utils/interfaces/aiProjectUpdate";
import { aiProjectUpdateLLMService } from "../../services/llm";
import { ProjectHelper } from "../projects/helper";
import { config } from "../../utils/configuration/config";
import { richTextToPlain } from "../../utils/helpers/richText";

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

// Sibling of DailyLogRoutes. Same envelope, same ownership idioms, same
// stateless generate + separate persistence. Differences are deliberate and
// listed in the spec: 422 instead of a silent slice above 50 photos; photo
// membership + URL rehydration from postFiles; a paged, searchable list.
export class AiProjectUpdateRoutes {
  // Whitelist of what the client may set. Photos are NOT taken from here —
  // resolvePhotos supplies them after the postFiles check.
  private static pickInput = (
    body: AuthenticatedRequest["body"],
    photos: IAiProjectUpdatePhoto[],
  ): IAiProjectUpdateInput => ({
    projectId: body.projectId,
    schemaVersion:
      Number(body.schemaVersion) || AI_PROJECT_UPDATE_SCHEMA_VERSION,
    title: String(body.title).trim(),
    projectName: body.projectName ?? "",
    projectAddress: body.projectAddress ?? "",
    startDate: body.startDate,
    endDate: body.endDate,
    timeZone: body.timeZone,
    language: toDailyLogLanguage(body.language),
    overviewDoc: body.overviewDoc ?? null,
    // Flattened for search; the rich doc itself cannot be regexed.
    bodyText: richTextToPlain(body.overviewDoc),
    titleEdited: body.titleEdited === true,
    overviewEdited: body.overviewEdited === true,
    photos,
    generation: AiProjectUpdateRoutes.pickGeneration(body.generation),
  });

  private static pickGeneration = (
    raw: unknown,
  ): IAiProjectUpdateGeneration | null => {
    if (!isRecord(raw)) return null;
    const generatedAt = new Date(String(raw.generatedAt ?? ""));
    if (Number.isNaN(generatedAt.getTime())) return null;
    return {
      generatedAt,
      fileIds: Array.isArray(raw.fileIds)
        ? raw.fileIds.map((id) => String(id))
        : [],
      language: toDailyLogLanguage(raw.language),
      photoCount: Number(raw.photoCount) || 0,
      descriptionCount: Number(raw.descriptionCount) || 0,
      commentCount: Number(raw.commentCount) || 0,
    };
  };

  // Field checks shared by create and update. Returns a 422 message or null.
  private static validateDocumentBody = (
    body: AuthenticatedRequest["body"],
  ): string | null => {
    const titleError = validateTitle(body.title);
    if (titleError) return titleError;
    const rangeError = validateDateRange(body.startDate, body.endDate);
    if (rangeError) return rangeError;
    if (!isValidTimeZone(body.timeZone)) return "timeZone is not recognised";
    if (
      body.language !== undefined &&
      !DAILY_LOG_LANGUAGES.includes(body.language)
    ) {
      return "language is not supported";
    }
    const docError = validateRichTextDoc(body.overviewDoc);
    if (docError) return docError;
    return null;
  };

  // Validates the photo list shape, proves every fileId is an active post
  // file of this project, and rehydrates url/quickView/postId from the
  // database so a client-controlled URL never reaches a PDF or the public
  // page. Sends the 422 itself and returns null on any failure.
  private static resolvePhotos = async (
    rawPhotos: unknown,
    projectId: string,
    res: express.Response,
  ): Promise<IAiProjectUpdatePhoto[] | null> => {
    const reject = (message: string) => {
      ErrorResponse(res, status.UNPROCESSABLE_ENTITY, { message });
      return null;
    };

    if (!Array.isArray(rawPhotos)) return reject("photos must be an array");
    const entries = rawPhotos.filter(isRecord);
    if (entries.length !== rawPhotos.length) return reject("Invalid photo");

    const idCheck = validateFileIds(entries.map((entry) => entry.fileId));
    if (idCheck.error) return reject(idCheck.error);

    for (const entry of entries) {
      const uploadedAt = entry.uploadedAt;
      if (
        typeof uploadedAt !== "string" ||
        Number.isNaN(new Date(uploadedAt).getTime())
      ) {
        return reject("Each photo needs an uploadedAt timestamp");
      }
    }

    const files = await AiProjectUpdateHelpers.findProjectPostFiles(
      idCheck.ids,
      ObjectId(projectId),
    );
    if (files.length !== idCheck.ids.length) {
      return reject("One or more photos do not belong to this project");
    }
    const byId = new Map<string, IPostFileRef>(
      files.map((file) => [String(file._id), file]),
    );

    // Client order is honoured; `order` is re-indexed to the array position so
    // gaps or duplicates from the client cannot persist.
    const ordered = [...entries].sort(
      (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0),
    );

    return ordered.map((entry, index) => {
      const fileId = String(entry.fileId);
      const file = byId.get(fileId) as IPostFileRef;
      const tags = Array.isArray(entry.tags)
        ? entry.tags.map((tag) => String(tag)).filter(Boolean)
        : undefined;
      return {
        fileId,
        postId: String(file.postId),
        url: file.url ?? "",
        quickView: file.quickView,
        order: index,
        uploadedBy: optionalString(entry.uploadedBy),
        uploadedById: optionalString(entry.uploadedById),
        uploadedAt: String(entry.uploadedAt),
        note: optionalString(entry.note)?.trim(),
        tags: tags?.length ? tags : undefined,
      };
    });
  };

  // ObjectId shape -> project exists -> project belongs to caller's company.
  // Sends 422/404/403 itself; returns false when a response has been sent.
  private static checkProjectAccess = async (
    req: AuthenticatedRequest,
    res: express.Response,
    projectId: unknown,
  ): Promise<boolean> => {
    if (typeof projectId !== "string" || !isValidObjectId(projectId)) {
      ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
        message: "Invalid projectId",
      });
      return false;
    }

    const project = await ProjectHelper.getCompanyId(ObjectId(projectId));

    if (!project) {
      ErrorResponse(res, status.NOT_FOUND, { message: "Project not found" });
      return false;
    }

    if (String(project.companyId) !== String(req.user.companyId)) {
      ErrorResponse(res, status.FORBIDDEN, {
        message: "You are not authorized to access this project",
      });
      return false;
    }

    return true;
  };

  private static loadForMutation = async (
    req: AuthenticatedRequest,
    res: express.Response,
    updateId: string,
  ): Promise<IAiProjectUpdateDocument | null> => {
    if (!updateId || !isValidObjectId(updateId)) {
      ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
        message: "Validation error",
      });
      return null;
    }

    const existing = (await AiProjectUpdateHelpers.findById(
      ObjectId(updateId),
    )) as IAiProjectUpdateDocument | null;

    if (!existing) {
      ErrorResponse(res, status.NOT_FOUND, {
        message: "Project update not found",
      });
      return null;
    }

    if (String(existing.companyId) !== String(req.user.companyId)) {
      ErrorResponse(res, status.FORBIDDEN, {
        message: "You are not authorized to modify this project update",
      });
      return null;
    }

    return existing;
  };

  // A 429/5xx/timeout from the model is transient, so the client is told to
  // retry. Anything else is reported as a plain failure it should not repeat.
  private static isRetryable = (error: unknown): boolean => {
    const candidate = error as { status?: number; name?: string };
    if (candidate?.status && RETRYABLE_STATUSES.has(candidate.status)) {
      return true;
    }
    const name = candidate?.name ?? "";
    return (
      name === "APIConnectionError" ||
      name === "APIConnectionTimeoutError" ||
      name === "APIUserAbortError" ||
      name === "TimeoutError" ||
      name === "AbortError"
    );
  };

  private static webUrlFor = (updateId: unknown): string =>
    `${config.WEB_URL}/project-update/${updateId}`;

  // The share-link payload. Everything not listed here stays private:
  // company/user/project ids, status, generation provenance, edit flags,
  // timestamps, and per-photo postId/note/tags/uploader.
  private static toPublic = (update: IAiProjectUpdateDocument) => ({
    _id: update._id,
    title: update.title,
    projectName: update.projectName ?? "",
    projectAddress: update.projectAddress ?? "",
    startDate: update.startDate,
    endDate: update.endDate,
    timeZone: update.timeZone,
    language: update.language,
    overviewDoc: update.overviewDoc ?? null,
    photos: (update.photos ?? []).map((photo) => ({
      fileId: photo.fileId,
      url: photo.url,
      quickView: photo.quickView,
      order: photo.order,
    })),
  });

  public static generate = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      if (
        Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8") >
        AI_PROJECT_UPDATE_GENERATE_MAX_BYTES
      ) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Request is too large",
        });
      }

      const validator = new Validator(req.body, {
        projectId: "required|string",
        timeZone: "required|string",
        startDate: "required|string",
        endDate: "required|string",
        photos: "required|array",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { projectId, startDate, endDate, timeZone } = req.body;

      if (
        !(await AiProjectUpdateRoutes.checkProjectAccess(req, res, projectId))
      ) {
        return;
      }

      const rangeError = validateDateRange(startDate, endDate);
      if (rangeError) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: rangeError,
        });
      }
      if (!isValidTimeZone(timeZone)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "timeZone is not recognised",
        });
      }

      const normalized = normalizeGeneratePhotos(req.body.photos);
      if (normalized.error) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: normalized.error,
        });
      }
      const photos = normalized.photos;

      const files = await AiProjectUpdateHelpers.findProjectPostFiles(
        photos.map((photo) => photo.fileId),
        ObjectId(projectId),
      );
      if (files.length !== photos.length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "One or more photos do not belong to this project",
        });
      }

      if (!hasUsableText(photos)) {
        console.warn("[aiProjectUpdates/generate] 422 — no usable text", {
          projectId,
          photoCount: photos.length,
          fileIds: photos.slice(0, 5).map((photo) => photo.fileId),
        });
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message:
            "The selected photos have no notes, comments, or tags to summarize.",
        });
      }

      const language = toDailyLogLanguage(req.body.language);
      const startedAt = Date.now();

      try {
        const result = await aiProjectUpdateLLMService.generateProjectUpdate({
          language,
          timeZone,
          startDate,
          endDate,
          projectName: optionalString(req.body.projectName),
          projectAddress: optionalString(req.body.projectAddress),
          photos,
        });

        return SuccessResponse(res, status.OK, {
          message: "Project update generated successfully",
          data: result,
        });
      } catch (error) {
        const failure = error as {
          status?: number;
          name?: string;
          message?: string;
        };
        const retryable = AiProjectUpdateRoutes.isRetryable(error);
        console.error("[aiProjectUpdates/generate] FAILED", {
          ms: Date.now() - startedAt,
          name: failure?.name,
          status: failure?.status,
          message: failure?.message,
          retryable,
        });

        if (retryable) {
          return ErrorResponse(res, status.SERVICE_UNAVAILABLE, {
            message: "Generation is temporarily unavailable. Please try again.",
            data: { retryable: true },
          });
        }
        return ErrorResponse(res, status.SERVICE_UNAVAILABLE, {
          message: "Generation failed. You can write the update yourself.",
          data: { retryable: false },
        });
      }
    } catch (error) {
      next(error);
    }
  };

  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectId: "required|string",
        title: "required|string",
        startDate: "required|string",
        endDate: "required|string",
        timeZone: "required|string",
        photos: "required|array",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      if (
        !(await AiProjectUpdateRoutes.checkProjectAccess(
          req,
          res,
          req.body.projectId,
        ))
      ) {
        return;
      }

      const bodyError = AiProjectUpdateRoutes.validateDocumentBody(req.body);
      if (bodyError) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: bodyError,
        });
      }

      const photos = await AiProjectUpdateRoutes.resolvePhotos(
        req.body.photos,
        req.body.projectId,
        res,
      );
      if (!photos) return;

      const update = await AiProjectUpdateHelpers.create({
        ...AiProjectUpdateRoutes.pickInput(req.body, photos),
        companyId: req.user.companyId,
        userId: req.user._id,
      });

      ProjectHelper.updateProjectInfo(update.projectId);

      return SuccessResponse(res, status.OK, {
        message: "Project update created successfully",
        data: {
          ...update.toObject(),
          webUrl: AiProjectUpdateRoutes.webUrlFor(update._id),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        id: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const updateId = req.params.id;

      if (!isValidObjectId(updateId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      const update = (await AiProjectUpdateHelpers.findById(
        ObjectId(updateId),
      )) as IAiProjectUpdateDocument | null;

      if (!update) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project update not found",
        });
      }

      if (String(update.companyId) !== String(req.user.companyId)) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "You are not authorized to view this project update",
        });
      }

      const branding = await AiProjectUpdateHelpers.findBranding({
        companyId: update.companyId,
        userId: update.userId,
      });

      return SuccessResponse(res, status.OK, {
        message: "Project update fetched successfully",
        data: {
          ...update,
          branding,
          webUrl: AiProjectUpdateRoutes.webUrlFor(update._id),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static list = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const projectId = req.query.projectId;

      if (!isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid projectId",
        });
      }

      const paging = normalizeUpdateListPaging(req.query);
      const search =
        typeof req.query.search === "string" ? req.query.search : undefined;

      const page = await AiProjectUpdateHelpers.listByProject(
        ObjectId(projectId),
        req.user.companyId,
        { ...paging, search },
      );

      return SuccessResponse(res, status.OK, {
        message: "Project updates fetched successfully",
        data: page.items.map((item) => ({
          ...item,
          webUrl: AiProjectUpdateRoutes.webUrlFor(item._id),
        })),
        totalCounts: updateListPagination(page.total, paging.limit).total,
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
      const validator = new Validator(
        { ...req.params, ...req.body },
        {
          id: "required|string",
          title: "required|string",
          startDate: "required|string",
          endDate: "required|string",
          timeZone: "required|string",
          photos: "required|array",
        },
      );

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const updateId = req.params.id;

      const existing = await AiProjectUpdateRoutes.loadForMutation(
        req,
        res,
        updateId,
      );
      if (!existing) {
        return;
      }

      const bodyError = AiProjectUpdateRoutes.validateDocumentBody(req.body);
      if (bodyError) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: bodyError,
        });
      }

      // projectId is fixed at creation — photos are checked against the STORED
      // project, and the stored id wins over whatever the body carries.
      const projectId = String(existing.projectId);
      const photos = await AiProjectUpdateRoutes.resolvePhotos(
        req.body.photos,
        projectId,
        res,
      );
      if (!photos) return;

      const input = AiProjectUpdateRoutes.pickInput(req.body, photos);
      input.projectId = projectId;

      const update = await AiProjectUpdateHelpers.update(
        ObjectId(updateId),
        input,
      );

      return SuccessResponse(res, status.OK, {
        message: "Project update updated successfully",
        data: {
          ...update,
          webUrl: AiProjectUpdateRoutes.webUrlFor(updateId),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static delete = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        id: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const updateId = req.params.id;

      const existing = await AiProjectUpdateRoutes.loadForMutation(
        req,
        res,
        updateId,
      );
      if (!existing) {
        return;
      }

      await AiProjectUpdateHelpers.moveToTrash(ObjectId(updateId));

      return SuccessResponse(res, status.OK, {
        message: "Project update deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  // Unauthenticated read behind the share link. Same posture as the daily
  // log: the ObjectId is the only secret, and toPublic keeps the payload to
  // what a customer should see.
  public static getPublic = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const updateId = req.params.id;

      if (!updateId || !isValidObjectId(updateId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      const update = (await AiProjectUpdateHelpers.findById(
        ObjectId(updateId),
      )) as IAiProjectUpdateDocument | null;

      if (!update) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project update not found",
        });
      }

      const branding = await AiProjectUpdateHelpers.findBranding({
        companyId: update.companyId,
        userId: update.userId,
      });

      return SuccessResponse(res, status.OK, {
        message: "Project update fetched successfully",
        data: { ...AiProjectUpdateRoutes.toPublic(update), branding },
      });
    } catch (error) {
      next(error);
    }
  };
}
