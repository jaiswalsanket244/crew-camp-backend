// NPM Dependencies
import * as status from "http-status";
import * as express from "express";
import { Validator } from "node-input-validator";

// Internal Dependencies
import { SheetHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { isValidObjectId, ObjectId } from "../../utils/helpers/commonHelper";
import {
  SHEET_DEFAULT_TITLE,
  SHEET_SCHEMA_VERSION,
  SHEET_TITLE_MAX_LENGTH,
} from "../../utils/enums/sheet";
import { ISheetDocument, ISheetInput } from "../../utils/interfaces/sheet";
import { ProjectHelper } from "../projects/helper";
import { richTextToPlain } from "../../utils/helpers/richText";
import { config } from "../../utils/configuration/config";

const validateSheetTitle = (title: unknown): string | null => {
  if (title === undefined || title === null) return null;
  if (typeof title !== "string") return "title must be a string";
  if (title.length > SHEET_TITLE_MAX_LENGTH) {
    return `title must be at most ${SHEET_TITLE_MAX_LENGTH} characters`;
  }
  return null;
};

export class SheetRoutes {
  private static webUrlFor = (sheetId: unknown): string =>
    `${config.WEB_URL}/sheet/${sheetId}`;

  private static pickInput = (body: AuthenticatedRequest["body"]) => {
    const input: ISheetInput = {
      projectId: body.projectId,
      schemaVersion: Number(body.schemaVersion) || SHEET_SCHEMA_VERSION,
      title: String(body.title ?? "").trim() || SHEET_DEFAULT_TITLE,
      projectName: body.projectName ?? "",
      projectAddress: body.projectAddress ?? "",
      bodyDoc: body.bodyDoc ?? null,
      // Flattened for search; the rich doc itself cannot be regexed.
      bodyText: richTextToPlain(body.bodyDoc),
      photos: Array.isArray(body.photos) ? body.photos : [],
    };
    return input;
  };

  private static loadForMutation = async (
    req: AuthenticatedRequest,
    res: express.Response,
    sheetId: string,
  ) => {
    if (!sheetId || !isValidObjectId(sheetId)) {
      ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
        message: "Validation error",
      });
      return null;
    }

    const sheet = await SheetHelpers.findById(ObjectId(sheetId));

    if (!sheet) {
      ErrorResponse(res, status.NOT_FOUND, { message: "Sheet not found" });
      return null;
    }

    if (String(sheet.companyId) !== String(req.user.companyId)) {
      ErrorResponse(res, status.FORBIDDEN, {
        message: "You are not authorized to modify this sheet",
      });
      return null;
    }

    return sheet;
  };

  // The share payload carries only what the PDF prints.
  private static toPublic = (sheet: ISheetDocument) => ({
    _id: sheet._id,
    title: sheet.title,
    projectName: sheet.projectName ?? "",
    projectAddress: sheet.projectAddress ?? "",
    bodyDoc: sheet.bodyDoc ?? null,
    photos: (sheet.photos ?? []).map((photo) => ({
      fileId: photo.fileId,
      url: photo.url,
      quickView: photo.quickView,
      order: photo.order,
    })),
    createdAt: sheet.createdAt,
  });

  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectId: "required|string",
      });

      if (!(await validator.check())) {
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

      const titleError = validateSheetTitle(req.body.title);
      if (titleError) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: titleError,
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

      const sheet = await SheetHelpers.create({
        ...SheetRoutes.pickInput(req.body),
        companyId: req.user.companyId,
        userId: req.user._id,
      });

      ProjectHelper.updateProjectInfo(sheet.projectId);

      return SuccessResponse(res, status.OK, {
        message: "Sheet created successfully",
        data: { ...sheet.toObject(), webUrl: SheetRoutes.webUrlFor(sheet._id) },
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
      const sheetId = req.params.id;

      if (!sheetId || !isValidObjectId(sheetId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      const sheet = await SheetHelpers.findById(ObjectId(sheetId));

      if (!sheet) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Sheet not found",
        });
      }

      if (String(sheet.companyId) !== String(req.user.companyId)) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "You are not authorized to view this sheet",
        });
      }

      const branding = await SheetHelpers.findBranding({
        companyId: sheet.companyId,
        userId: sheet.userId,
      });

      return SuccessResponse(res, status.OK, {
        message: "Sheet fetched successfully",
        data: { ...sheet, branding, webUrl: SheetRoutes.webUrlFor(sheet._id) },
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
      const existing = await SheetRoutes.loadForMutation(
        req,
        res,
        req.params.id,
      );
      if (!existing) {
        return;
      }

      const titleError = validateSheetTitle(req.body.title);
      if (titleError) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: titleError,
        });
      }

      const sheet = await SheetHelpers.update(
        ObjectId(req.params.id),
        SheetRoutes.pickInput({ ...req.body, projectId: existing.projectId }),
      );

      return SuccessResponse(res, status.OK, {
        message: "Sheet updated successfully",
        data: { ...sheet, webUrl: SheetRoutes.webUrlFor(req.params.id) },
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
      const existing = await SheetRoutes.loadForMutation(
        req,
        res,
        req.params.id,
      );
      if (!existing) {
        return;
      }

      await SheetHelpers.moveToTrash(ObjectId(req.params.id));

      return SuccessResponse(res, status.OK, {
        message: "Sheet deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  // Unauthenticated read behind the share link, mirroring the daily log's.
  public static getPublic = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const sheetId = req.params.id;

      if (!sheetId || !isValidObjectId(sheetId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      const sheet = (await SheetHelpers.findById(
        ObjectId(sheetId),
      )) as ISheetDocument | null;

      if (!sheet) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Sheet not found",
        });
      }

      const branding = await SheetHelpers.findBranding({
        companyId: sheet.companyId,
        userId: sheet.userId,
      });

      return SuccessResponse(res, status.OK, {
        message: "Sheet fetched successfully",
        data: { ...SheetRoutes.toPublic(sheet), branding },
      });
    } catch (error) {
      next(error);
    }
  };
}
