import * as express from "express";
import * as status from "http-status";
import { Validator } from "node-input-validator";

import {
  ErrorResponse,
  SuccessResponse,
} from "../../../../utils/helpers/apiResponse";
import { ApiKeyAuthenticatedRequest } from "../../../../middleware/apiKeyAuth";
import { awsHelpers } from "../../../aws/helpers";
import { config } from "../../../../utils/configuration/config";
import { buildS3ObjectKey } from "../../../../utils/helpers/commonHelper";
import { IPreSignedUrlPayload } from "../../../../utils/interfaces/files";
import { IInitiateMultipartPayload } from "../../../../utils/interfaces/multipartUpload";
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  MAX_S3_PARTS,
  MIN_CHUNK_SIZE_BYTES,
} from "../../../../utils/constants/constants";
import { ExternalApiHelper, MAX_FILES_PER_REQUEST } from "../helpers";
import { PendingUploadService } from "../../../../services/pendingUploads";

// Single-PUT ceiling. Anything larger has to go through multipart, which is
// resumable and doesn't hold a whole file in one request.
export const MAX_SINGLE_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_MULTIPART_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

// /v1 uploads exist to feed posts, so only photos and video are signable here.
// The internal API stays permissive because it also carries project documents.
const ALLOWED_MEDIA_TYPE = /^(image|video)\/[a-z0-9.+-]+$/i;

const isAllowedMediaType = (fileType: string): boolean =>
  ALLOWED_MEDIA_TYPE.test(String(fileType).trim());

const cdnUrlFor = (keyFile: string): string =>
  config.S3_BUCKET_CDN === "NA" ? "" : `${config.S3_BUCKET_CDN}/${keyFile}`;

/**
 * Photos and videos are uploaded straight to S3 by the caller; this layer only
 * signs the requests, caps them, and records what it handed out.
 *
 * Unlike the read wrappers these don't delegate to AwsRoutes — the generated
 * object key is needed here to track the upload for orphan reaping.
 */
export class ExternalUploadRoutes {
  public static getPreSignedUrl = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        fileName: "required|string|minLength:1|maxLength:255",
        fileType: "required|string|minLength:1|maxLength:255",
        fileSizeBytes: `required|integer|min:1|max:${MAX_SINGLE_UPLOAD_BYTES}`,
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

      const body = req.body as IPreSignedUrlPayload;
      if (!isAllowedMediaType(body.fileType)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "fileType must be an image/* or video/* media type",
        });
      }

      const keyFile = buildS3ObjectKey(body.fileName, companyId.toString());
      const { url, returnUrl } = await awsHelpers.getSignedUrl(
        keyFile,
        body.fileType,
        body.fileSizeBytes,
      );

      await PendingUploadService.record({
        companyId,
        userId: req.user._id,
        keyFile,
        url: returnUrl,
        fileType: body.fileType,
        sizeBytes: body.fileSizeBytes,
      });

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: { url, keyFile, returnUrl },
      });
    } catch (error) {
      next(error);
    }
  };

  // The internal handler takes a bare array as its body, so this is validated
  // by hand rather than through a field schema.
  public static getMultiPreSignedUrl = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const files = req.body as IPreSignedUrlPayload[];

      if (!Array.isArray(files) || !files.length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message:
            "body must be a non-empty array of { fileName, fileType, fileSizeBytes }",
        });
      }
      if (files.length > MAX_FILES_PER_REQUEST) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `at most ${MAX_FILES_PER_REQUEST} files per request`,
        });
      }

      const companyId = ExternalApiHelper.getCompanyId(req);
      if (!companyId) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "API key is not associated with a company",
        });
      }

      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (!file || typeof file !== "object") {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `body[${index}] must be an object`,
          });
        }
        if (typeof file.fileName !== "string" || !file.fileName.trim()) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `body[${index}].fileName is required`,
          });
        }
        if (
          typeof file.fileType !== "string" ||
          !isAllowedMediaType(file.fileType)
        ) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `body[${index}].fileType must be an image/* or video/* media type`,
          });
        }
        const size = Number(file.fileSizeBytes);
        if (
          !Number.isInteger(size) ||
          size < 1 ||
          size > MAX_SINGLE_UPLOAD_BYTES
        ) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `body[${index}].fileSizeBytes must be between 1 and ${MAX_SINGLE_UPLOAD_BYTES}`,
          });
        }
      }

      const data = await Promise.all(
        files.map(async (file) => {
          const keyFile = buildS3ObjectKey(file.fileName, companyId.toString());
          const { url, returnUrl } = await awsHelpers.getSignedUrl(
            keyFile,
            file.fileType,
            Number(file.fileSizeBytes),
          );
          return { url, keyFile, returnUrl, fileType: file.fileType };
        }),
      );

      await PendingUploadService.recordMany(
        data.map((entry, index) => ({
          companyId,
          userId: req.user._id,
          keyFile: entry.keyFile,
          url: entry.returnUrl,
          fileType: entry.fileType,
          sizeBytes: Number(files[index].fileSizeBytes),
        })),
      );

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: {
          data: data.map(({ url, keyFile, returnUrl }) => ({
            url,
            keyFile,
            returnUrl,
          })),
          bucketName: config.S3_BUCKET_NAME,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static initiateMultipart = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        fileName: "required|string|minLength:1|maxLength:255",
        fileType: "required|string|minLength:1|maxLength:255",
        fileSizeBytes: `required|integer|min:1|max:${MAX_MULTIPART_UPLOAD_BYTES}`,
        chunkSizeBytes: `integer|min:${MIN_CHUNK_SIZE_BYTES}`,
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

      const body = req.body as IInitiateMultipartPayload;
      if (!isAllowedMediaType(body.fileType)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "fileType must be an image/* or video/* media type",
        });
      }

      const chunkSizeBytes = body.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
      const partCount = Math.ceil(body.fileSizeBytes / chunkSizeBytes);
      if (partCount > MAX_S3_PARTS) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `chunkSizeBytes too small: would require ${partCount} parts (S3 max is ${MAX_S3_PARTS})`,
        });
      }

      const keyFile = buildS3ObjectKey(body.fileName, companyId.toString());
      const result = await awsHelpers.initiateMultipart(
        keyFile,
        body.fileType,
        body.fileSizeBytes,
        chunkSizeBytes,
      );

      await PendingUploadService.record({
        companyId,
        userId: req.user._id,
        keyFile,
        url: cdnUrlFor(keyFile),
        fileType: body.fileType,
        sizeBytes: body.fileSizeBytes,
        uploadId: result.uploadId,
      });

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  // Aborting discards the upload, so the tracking row goes with it. Any parts
  // S3 still holds are swept by the nightly stale-multipart pass.
  public static abortMultipart = async (
    req: ApiKeyAuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        uploadId: "required|string",
        keyFile: "required|string",
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

      const { uploadId, keyFile } = req.body;

      // Scope check: only abort an upload this company started.
      const owned = await PendingUploadService.findOwned(keyFile, companyId);
      if (!owned) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Upload not found",
        });
      }

      await awsHelpers.abortMultipart(uploadId, keyFile);
      await PendingUploadService.remove(keyFile);

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: { aborted: true },
      });
    } catch (error) {
      next(error);
    }
  };
}
