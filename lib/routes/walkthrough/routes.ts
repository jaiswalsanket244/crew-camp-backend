import * as express from "express";
import * as status from "http-status";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { WalkthroughHelpers } from "./helpers";

export class WalkthroughRoutes {
  public static generateReport = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { sentences, photos } = req.body;

      if (!sentences || !Array.isArray(sentences)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "sentences array is required.",
        });
      }

      const sections = await WalkthroughHelpers.generateReport(
        sentences,
        photos ?? [],
      );

      return SuccessResponse(res, status.OK, {
        message: "Report generated successfully.",
        data: { sections },
      });
    } catch (error) {
      next(error);
    }
  };

  public static processAndGenerate = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      if (!req.file) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Audio file is required.",
        });
      }

      let photos: { timestamp: number; url?: string }[] = [];
      if (req.body.photos) {
        try {
          photos = JSON.parse(req.body.photos);
        } catch {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Invalid photos format. Expected a JSON array.",
          });
        }
      }

      const sections = await WalkthroughHelpers.processAndGenerate(
        req.file.buffer,
        photos,
      );

      const saveReport =
        req.body.saveReport === true || req.body.saveReport === "true";
      if (!saveReport) {
        return SuccessResponse(res, status.OK, {
          message: "Report generated successfully.",
          data: { sections },
        });
      }

      const { projectId, reportName } = req.body;
      if (!projectId || !reportName) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message:
            "projectId and reportName are required when saveReport is true.",
        });
      }

      const missing = photos.filter((photo) => !photo.url).length;
      if (missing > 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `All photos must include a url when saveReport is true (${missing} missing).`,
        });
      }

      const saved = await WalkthroughHelpers.saveGeneratedReport({
        sections,
        photos,
        projectId,
        reportName,
        companyId: req.user.companyId,
        userId: req.user._id,
      });

      return SuccessResponse(res, status.OK, {
        message: "Report generated and saved successfully.",
        data: { sections, reportId: saved.reportId },
      });
    } catch (error) {
      next(error);
    }
  };
}
