import * as status from "http-status";
import * as express from "express";
import { Types } from "mongoose";
import { Validator } from "node-input-validator";

import { ProjectDocumentHelpers, IDocumentRow } from "./helpers";
import {
  DOCUMENT_TYPE,
  decodeDocumentCursor,
  encodeDocumentCursor,
  normalizeDocumentAuthors,
  normalizeDocumentLimit,
  normalizeDocumentRange,
  normalizeDocumentTypes,
} from "./listQuery";
import { AiProjectUpdates, DailyLogs, ProjectReports, Sheets } from "../../db";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { isValidObjectId, ObjectId } from "../../utils/helpers/commonHelper";
import { config } from "../../utils/configuration/config";

// Each type opens at its own route, so the share/open links differ per row.
const WEB_PATH: Record<DOCUMENT_TYPE, string> = {
  [DOCUMENT_TYPE.DAILY_LOG]: "daily-log",
  [DOCUMENT_TYPE.PROJECT_UPDATE]: "project-update",
  [DOCUMENT_TYPE.SHEET]: "sheet",
  [DOCUMENT_TYPE.WALKTHROUGH]: "report",
  [DOCUMENT_TYPE.REPORT]: "report",
};

const renameById = async (args: {
  type: DOCUMENT_TYPE;
  id: Types.ObjectId;
  companyId: Types.ObjectId;
  title: string;
}): Promise<boolean> => {
  const filter = { _id: args.id, companyId: args.companyId };
  const byTitle = { $set: { title: args.title } };

  if (args.type === DOCUMENT_TYPE.DAILY_LOG) {
    return (await DailyLogs.updateOne(filter, byTitle)).matchedCount > 0;
  }
  if (args.type === DOCUMENT_TYPE.PROJECT_UPDATE) {
    return (await AiProjectUpdates.updateOne(filter, byTitle)).matchedCount > 0;
  }
  if (args.type === DOCUMENT_TYPE.SHEET) {
    return (await Sheets.updateOne(filter, byTitle)).matchedCount > 0;
  }

  return (
    (
      await ProjectReports.updateOne(filter, {
        $set: { reportName: args.title },
      })
    ).matchedCount > 0
  );
};

// Same cap the three editors enforce.
const DOCUMENT_TITLE_MAX_LENGTH = 120;

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

export class ProjectDocumentRoutes {
  public static list = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "required|string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const projectId = req.query.projectId as string;

      if (!isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid projectId",
        });
      }

      const limit = normalizeDocumentLimit(req.query.limit as string);
      const types = normalizeDocumentTypes(req.query.types as string);
      const cursor = decodeDocumentCursor(req.query.cursor as string);
      const authors = normalizeDocumentAuthors(req.query.authors as string).map(
        (id) => ObjectId(id),
      );
      const range = normalizeDocumentRange(
        req.query.startDate as string,
        req.query.endDate as string,
      );

      const filters = {
        projectId: ObjectId(projectId),
        companyId: req.user.companyId,
        types,
        search: req.query.search as string,
        authors,
        range,
      };

      const [rows, totalCounts] = await Promise.all([
        ProjectDocumentHelpers.list({ ...filters, limit, cursor }),
        cursor
          ? Promise.resolve(undefined)
          : ProjectDocumentHelpers.count(filters),
      ]);

      const hasMore = rows.length > limit;
      const page: IDocumentRow[] = hasMore ? rows.slice(0, limit) : rows;
      const decorated = await ProjectDocumentHelpers.decorate(page);
      const last = page[page.length - 1];

      return SuccessResponse(res, status.OK, {
        message: "Documents fetched successfully",
        data: decorated.map((row) => ({
          _id: row._id,
          type: row.type,
          title: row.title,
          excerpt: row.excerpt,
          photoCount: row.photoCount,
          author: row.author,
          authorInitials: initialsOf(row.author ?? ""),
          date: row.date,
          webUrl: `${config.WEB_URL}/${WEB_PATH[row.type]}/${row._id}`,
        })),
        totalCounts,
        nextCursor:
          hasMore && last
            ? encodeDocumentCursor({
                date: new Date(last.date).toISOString(),
                id: String(last._id),
              })
            : null,
      });
    } catch (error) {
      next(error);
    }
  };

  public static rename = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        type: "required|string",
        title: `required|string|maxLength:${DOCUMENT_TITLE_MAX_LENGTH}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const title = String(req.body.title).trim();
      const type = req.body.type as DOCUMENT_TYPE;

      if (!title || Object.values(DOCUMENT_TYPE).indexOf(type) === -1) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      if (!isValidObjectId(req.params.id)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      const renamed = await renameById({
        type,
        id: ObjectId(req.params.id),
        companyId: req.user.companyId,
        title,
      });

      if (!renamed) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Document not found",
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "Document renamed successfully",
        data: { _id: req.params.id, title },
      });
    } catch (error) {
      next(error);
    }
  };
}
