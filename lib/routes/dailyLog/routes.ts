// NPM Dependencies
import * as status from "http-status";
import * as express from "express";
import { Validator } from "node-input-validator";

// Internal Dependencies
import { DailyLogHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { isValidObjectId, ObjectId } from "../../utils/helpers/commonHelper";
import {
  DAILY_LOG_SCHEMA_VERSION,
  DAILY_LOG_TITLE_MAX_LENGTH,
  toDailyLogLanguage,
} from "../../utils/enums/dailyLog";
import {
  DailyLogGenerateMode,
  DailyLogSection,
  IDailyLogDocument,
  IDailyLogGeneratePhoto,
  IDailyLogInput,
  IDailyLogListItem,
} from "../../utils/interfaces/dailyLog";
import { dailyLogLLMService } from "../../services/llm";
import { ProjectHelper } from "../projects/helper";
import { richTextsToPlain } from "../../utils/helpers/richText";
import { config } from "../../utils/configuration/config";

const ALL_SECTIONS: DailyLogSection[] = ["overview", "todos"];

const MAX_GENERATE_PHOTOS = 50;

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

export class DailyLogRoutes {
  private static pickInput = (body: AuthenticatedRequest["body"]) => {
    const input: IDailyLogInput = {
      projectId: body.projectId,
      schemaVersion: Number(body.schemaVersion) || DAILY_LOG_SCHEMA_VERSION,
      title: body.title,
      projectName: body.projectName ?? "",
      projectAddress: body.projectAddress ?? "",
      summaryDate: body.summaryDate,
      language: toDailyLogLanguage(body.language),
      contributors: Array.isArray(body.contributors) ? body.contributors : [],
      overviewDoc: body.overviewDoc ?? null,
      photos: Array.isArray(body.photos) ? body.photos : [],
      todos: Array.isArray(body.todos) ? body.todos : [],
      notesDoc: body.notesDoc ?? null,
      // Flattened for search; the rich docs themselves cannot be regexed.
      bodyText: richTextsToPlain([body.overviewDoc, body.notesDoc]),
      generatedFromFileIds: Array.isArray(body.generatedFromFileIds)
        ? body.generatedFromFileIds.map((id: unknown) => String(id))
        : undefined,
    };
    return input;
  };

  private static loadForMutation = async (
    req: AuthenticatedRequest,
    res: express.Response,
    dailyLogId: string,
  ) => {
    if (!dailyLogId || !isValidObjectId(dailyLogId)) {
      ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
        message: "Validation error",
      });
      return null;
    }

    const dailyLog = await DailyLogHelpers.findById(ObjectId(dailyLogId));

    if (!dailyLog) {
      ErrorResponse(res, status.NOT_FOUND, { message: "Daily log not found" });
      return null;
    }

    if (String(dailyLog.companyId) !== String(req.user.companyId)) {
      ErrorResponse(res, status.FORBIDDEN, {
        message: "You are not authorized to modify this daily log",
      });
      return null;
    }

    return dailyLog;
  };

  private static parseSections = (raw: unknown): DailyLogSection[] => {
    if (!Array.isArray(raw)) return ALL_SECTIONS;
    const picked = ALL_SECTIONS.filter((section) => raw.includes(section));
    return picked.length ? picked : ALL_SECTIONS;
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
      name === "APIUserAbortError"
    );
  };

  private static webUrlFor = (dailyLogId: unknown): string =>
    `${config.WEB_URL}/daily-log/${dailyLogId}`;

  private static toPublic = (dailyLog: IDailyLogDocument) => ({
    _id: dailyLog._id,
    title: dailyLog.title,
    projectName: dailyLog.projectName ?? "",
    projectAddress: dailyLog.projectAddress ?? "",
    summaryDate: dailyLog.summaryDate,
    language: dailyLog.language,
    contributors: (dailyLog.contributors ?? []).map((contributor) => ({
      name: contributor.name,
    })),
    overviewDoc: dailyLog.overviewDoc ?? null,
    notesDoc: dailyLog.notesDoc ?? null,
    todos: (dailyLog.todos ?? []).map((todo) => ({
      text: todo.text,
      done: todo.done,
    })),
    photos: (dailyLog.photos ?? []).map((photo) => ({
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
      const validator = new Validator(req.body, {
        projectId: "required|string",
        date: "required|string",
        photos: "required|array",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { projectId, date } = req.body;

      if (!isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid projectId",
        });
      }

      const project = await ProjectHelper.getCompanyId(ObjectId(projectId));

      if (!project) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project not found",
        });
      }

      if (String(project.companyId) !== String(req.user.companyId)) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "You are not authorized to access this project",
        });
      }

      const photos: IDailyLogGeneratePhoto[] = (req.body.photos as unknown[])
        .slice(0, MAX_GENERATE_PHOTOS)
        .map((entry) => {
          const photo = entry as Partial<IDailyLogGeneratePhoto>;
          return {
            fileId: String(photo.fileId ?? ""),
            postId: photo.postId ? String(photo.postId) : undefined,
            description: String(photo.description ?? ""),
            tags: Array.isArray(photo.tags)
              ? photo.tags.map((tag) => String(tag)).filter(Boolean)
              : undefined,
            isNew: photo.isNew === true,
            takenAt: photo.takenAt ? String(photo.takenAt) : undefined,
          };
        });

      if (!photos.length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Select at least one photo to generate a daily log",
        });
      }

      const hasUsableDescription = photos.some(
        (photo) => photo.description.trim().length > 0 || photo.tags?.length,
      );

      if (!hasUsableDescription) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message:
            "The selected photos have no notes, comments, or tags to summarize.",
        });
      }

      const sections = DailyLogRoutes.parseSections(req.body.sections);
      const language = toDailyLogLanguage(req.body.language);
      const mode: DailyLogGenerateMode =
        req.body.mode === "append" ? "append" : "full";

      // Append mode is pointless without at least one new photo — fall back to
      // a full run rather than asking the model for additions to nothing.
      const hasNewPhotos = photos.some((photo) => photo.isNew);
      const effectiveMode: DailyLogGenerateMode =
        mode === "append" && hasNewPhotos ? "append" : "full";

      const existingTodos = Array.isArray(req.body.existingTodos)
        ? (req.body.existingTodos as unknown[])
            .map((todo) => String(todo ?? "").trim())
            .filter(Boolean)
        : undefined;

      try {
        const result = await dailyLogLLMService.generateDailyLog({
          date,
          language,
          sections,
          photos,
          projectName: req.body.projectName,
          projectAddress: req.body.projectAddress,
          mode: effectiveMode,
          existingOverview:
            typeof req.body.existingOverview === "string"
              ? req.body.existingOverview
              : undefined,
          existingTodos,
        });

        return SuccessResponse(res, status.OK, {
          message: "Daily log generated successfully",
          data: result,
        });
      } catch (error) {
        if (DailyLogRoutes.isRetryable(error)) {
          return ErrorResponse(res, status.SERVICE_UNAVAILABLE, {
            message: "Generation is temporarily unavailable. Please try again.",
            data: { retryable: true },
          });
        }
        return ErrorResponse(res, status.SERVICE_UNAVAILABLE, {
          message:
            "Generation failed. You can write the overview and to-dos yourself.",
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
        title: `required|string|maxLength:${DAILY_LOG_TITLE_MAX_LENGTH}`,
        summaryDate: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      if (!isValidObjectId(req.body.projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid projectId",
        });
      }

      const project = await ProjectHelper.getCompanyId(
        ObjectId(req.body.projectId),
      );

      if (!project) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project not found",
        });
      }

      if (String(project.companyId) !== String(req.user.companyId)) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "You are not authorized to access this project",
        });
      }

      const dailyLog = await DailyLogHelpers.create({
        ...DailyLogRoutes.pickInput(req.body),
        companyId: req.user.companyId,
        userId: req.user._id,
      });

      ProjectHelper.updateProjectInfo(dailyLog.projectId);

      return SuccessResponse(res, status.OK, {
        message: "Daily log created successfully",
        data: {
          ...dailyLog.toObject(),
          webUrl: DailyLogRoutes.webUrlFor(dailyLog._id),
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

      const dailyLogId = req.params.id;

      if (!isValidObjectId(dailyLogId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      const dailyLog = await DailyLogHelpers.findById(ObjectId(dailyLogId));

      if (!dailyLog) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Daily log not found",
        });
      }

      if (String(dailyLog.companyId) !== String(req.user.companyId)) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "You are not authorized to view this daily log",
        });
      }

      const branding = await DailyLogHelpers.findBranding({
        companyId: dailyLog.companyId,
        userId: dailyLog.userId,
      });

      return SuccessResponse(res, status.OK, {
        message: "Daily log fetched successfully",
        data: {
          ...dailyLog,
          branding,
          webUrl: DailyLogRoutes.webUrlFor(dailyLog._id),
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

      const dailyLogs = await DailyLogHelpers.listByProject(
        ObjectId(projectId),
        req.user.companyId,
      );

      return SuccessResponse(res, status.OK, {
        message: "Daily logs fetched successfully",
        data: dailyLogs.map((dailyLog: IDailyLogListItem) => ({
          ...dailyLog,
          webUrl: DailyLogRoutes.webUrlFor(dailyLog._id),
        })),
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
          title: `required|string|maxLength:${DAILY_LOG_TITLE_MAX_LENGTH}`,
          summaryDate: "required|string",
        },
      );

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const dailyLogId = req.params.id;

      const existing = await DailyLogRoutes.loadForMutation(
        req,
        res,
        dailyLogId,
      );
      if (!existing) {
        return;
      }

      // projectId is fixed at creation — an update must not move a log between
      // projects, so the stored value wins over whatever the body carries.
      const update = DailyLogRoutes.pickInput(req.body);
      update.projectId = String(existing.projectId);

      const dailyLog = await DailyLogHelpers.update(
        ObjectId(dailyLogId),
        update,
      );

      return SuccessResponse(res, status.OK, {
        message: "Daily log updated successfully",
        data: { ...dailyLog, webUrl: DailyLogRoutes.webUrlFor(dailyLog._id) },
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

      const dailyLogId = req.params.id;

      const existing = await DailyLogRoutes.loadForMutation(
        req,
        res,
        dailyLogId,
      );
      if (!existing) {
        return;
      }

      await DailyLogHelpers.moveToTrash(ObjectId(dailyLogId));

      return SuccessResponse(res, status.OK, {
        message: "Daily log deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getPublic = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const dailyLogId = req.params.id;

      if (!dailyLogId || !isValidObjectId(dailyLogId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      const dailyLog = (await DailyLogHelpers.findById(
        ObjectId(dailyLogId),
      )) as IDailyLogDocument | null;

      if (!dailyLog) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Daily log not found",
        });
      }

      const branding = await DailyLogHelpers.findBranding({
        companyId: dailyLog.companyId,
        userId: dailyLog.userId,
      });

      return SuccessResponse(res, status.OK, {
        message: "Daily log fetched successfully",
        data: { ...DailyLogRoutes.toPublic(dailyLog), branding },
      });
    } catch (error) {
      next(error);
    }
  };
}
