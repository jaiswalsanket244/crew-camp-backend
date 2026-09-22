// NPM Dependencies
import * as express from "express";
import * as status from "http-status";
import { fileService } from "../../services/awsBucket";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import axios from "axios";
import { Validator } from "node-input-validator";
import { FilesHelper } from "./helper";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { FILES_STORAGE_LIMIT } from "../../utils/constants/constants";
import { config } from "../../utils/configuration/config";
import { ObjectId, sanitizeFileName } from "../../utils/helpers/commonHelper";
import { isValidObjectId } from "mongoose";
import { awsHelpers } from "../aws/helpers";
import { onFileUploaded } from "../../integrations/hooks";
import { GalleryHelper } from "../gallery/helper";
import AWSSQSService from "../../services/awsSqs";
import { ProjectHelper } from "../projects/helper";

// Custom interface for req containing files
export interface FileRequest extends express.Request {
  files: {
    file: any;
  };
}

export class FileRoutes {
  public static upload = async (
    req: FileRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { file } = req.body;
      await fileService.uploadToS3(file);
      return SuccessResponse(res, status.OK, {
        message: "Data uploaded successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static delete = async (
    req: FileRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { file } = req.body;
      await fileService.deleteFromS3(file);
      return SuccessResponse(res, status.OK, {
        message: "File deleted successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static proxy = async (req, res) => {
    const videoUrl = req.query.url;
    const file = await axios.get(videoUrl, { responseType: "stream" });
    file.data.pipe(res);
  };

  public static getPreSignedUrl = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        fileName: "string|required",
        fileType: "string|required",
        size: "numeric|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const { fileName, fileType, size } = req.body;
      const companyId = req.user.companyId;

      const current = await FilesHelper.fetchCurrentCapacity(
        req.user.companyId,
      );

      if (current[0]?.size + size > FILES_STORAGE_LIMIT) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Storage limit exceeded",
        });
      }

      const keyFile = `${companyId.toString() + "/files/"}${Date.now() + sanitizeFileName(fileName)}`;

      const { url, returnUrl } = await awsHelpers.getSignedUrl(
        keyFile,
        fileType,
      );

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: { url, keyFile, returnUrl, bucketName: config.S3_BUCKET_NAME },
      });
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
        fileName: "string|required",
        fileType: "string|required",
        size: "numeric|required",
        accessLevel: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { fileName, fileType, size, projectId, url, accessLevel } =
        req.body;
      const { companyId, _id } = req.user;

      const current = await FilesHelper.fetchCurrentCapacity(
        req.user.companyId,
      );

      if (current[0]?.size + size > FILES_STORAGE_LIMIT) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Storage limit exceeded",
        });
      }

      const data = await FilesHelper.create({
        companyId,
        projectId,
        userId: _id,
        name: fileName,
        fileType,
        size,
        url: url,
        accessLevel,
      });

      if (projectId) {
        ProjectHelper.updateProjectInfo(projectId);
      }

      // Trigger CRM integration sync (async, non-blocking)
      if (projectId) {
        onFileUploaded(
          projectId,
          { url, fileName, mimeType: fileType },
          req.user as any,
        ).catch((err) => {
          console.error("Integration hook error:", err);
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateFile = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        name: "string|required",
        accessLevel: "string|required",
        fileId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const { name, accessLevel, fileId } = req.body;

      if (!fileId || !isValidObjectId(fileId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid fileId",
        });
      }

      const file = await FilesHelper.update(fileId, {
        name,
        accessLevel,
      });

      if (file?.projectId) {
        ProjectHelper.updateProjectInfo(file.projectId);
      }

      return SuccessResponse(res, status.OK, {
        message: "update successful.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteFile = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const fileId = req.params.id;

      if (!fileId || !isValidObjectId(fileId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid fileId",
        });
      }

      await FilesHelper.delete(fileId);

      return SuccessResponse(res, status.OK, {
        message: "update successful.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getFiles = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const projectId = req.query?.projectId || "";
      const search = req.query?.search || "";
      const limit = req.query?.limit
        ? parseInt(req.query.limit as string, 10)
        : undefined;
      const userId = req.user._id;
      const userRole = req.user?.companies?.[0]?.role;

      const [data, totalCounts] = await Promise.all([
        FilesHelper.getFilesByProject(
          req.user.companyId,
          ObjectId(projectId),
          userId,
          userRole,
          search.trim(),
          limit,
        ),
        FilesHelper.countByProject(
          req.user.companyId,
          ObjectId(projectId),
          userId,
          userRole,
        ),
      ]);

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data,
        totalCounts,
      });
    } catch (error) {
      next(error);
    }
  };

  public static downloadFile = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { galleryId, email } = req.query;
      const sqsService = AWSSQSService.getInstance();

      if (!galleryId || !isValidObjectId(galleryId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid galleryId",
        });
      }

      // Send response immediately
      SuccessResponse(res, status.OK, {
        message: "Download link will be shared shortly.",
      });

      const gallery = await GalleryHelper.findFilesWithTheirData(
        ObjectId(galleryId),
      );

      if (!gallery.length) {
        return;
      }

      const files = gallery.map((g) => {
        const fileData = {
          url: g.files.url,
          name: g.files.url.split("/").pop(),
        };
        if (fileData.url.includes("cloudfront")) {
          const temp = fileData.url.split("/");
          temp[2] = `${config.S3_BUCKET_NAME}.s3.amazonaws.com`;
          fileData.url = temp.join("/");
        }
        return {
          ...fileData,
        };
      });

      // Use single download job to avoid multiple tasks
      // This will either send files directly in SQS (if small) or use S3 manifest (if large)
      await sqsService.createSingleDownloadJob(files, email);
    } catch (error) {
      next(error);
    }
  };
}
