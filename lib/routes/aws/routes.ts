// NPM Dependencies
import * as express from "express";
import * as status from "http-status";
import { Validator } from "node-input-validator";

// Internal Dependencies
import { awsHelpers } from "./helpers";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { config } from "../../utils/configuration/config";
import {
  getTimeFormatForS3,
  sanitizeFileName,
} from "../../utils/helpers/commonHelper";
import { IPreSignedUrlPayload } from "../../utils/interfaces/files";
import {
  IAbortMultipartPayload,
  ICompleteMultipartPayload,
  ICompletedPart,
  IGetPartUrlsPayload,
  IInitiateMultipartPayload,
  IListPartsQuery,
} from "../../utils/interfaces/multipartUpload";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_S3_PARTS,
  MIN_CHUNK_SIZE_BYTES,
  DEFAULT_CHUNK_SIZE_BYTES,
  S3_PART_ETAG_REGEX,
} from "../../utils/constants/constants";

export class AwsRoutes {
  public static getPreSignedUrl = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: IPreSignedUrlPayload = req.body;
      const { fileName, fileType } = query;
      const keyFile = `${getTimeFormatForS3()}--${sanitizeFileName(fileName)}`;

      const { url } = await awsHelpers.getSignedUrl(keyFile, fileType);
      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: { url, keyFile },
      });
    } catch (error) {
      next(error);
    }
  };

  public static getMultiPreSignedUrl = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: IPreSignedUrlPayload[] = req.body;

      const data = await Promise.all(
        query.map(async (file) => {
          const { fileName, fileType } = file;
          const keyFile = `${getTimeFormatForS3()}--${sanitizeFileName(fileName)}`;
          const { url, returnUrl } = await awsHelpers.getSignedUrl(
            keyFile,
            fileType,
          );
          return { url, keyFile, returnUrl };
        }),
      );
      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: { data, bucketName: config.S3_BUCKET_NAME },
      });
    } catch (error) {
      next(error);
    }
  };

  public static initiateMultipart = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        fileName: "required|string",
        fileType: "required|string",
        fileSizeBytes: `required|integer|min:1|max:${MAX_FILE_SIZE_BYTES}`,
        // S3's 5 MiB-per-part minimum.
        chunkSizeBytes: `integer|min:${MIN_CHUNK_SIZE_BYTES}`,
      });

      const body = req.body as IInitiateMultipartPayload;

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation failed",
          errors: validator.errors,
        });
      }

      const chunkSizeBytes = body.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;

      // Pre-validate part count so the helper doesn't throw → 500. This is a
      // precondition violation, not a server error.
      const partCount = Math.ceil(body.fileSizeBytes / chunkSizeBytes);
      if (partCount > MAX_S3_PARTS) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `chunkSizeBytes too small: would require ${partCount} parts (S3 max is ${MAX_S3_PARTS})`,
        });
      }

      const keyFile = `${getTimeFormatForS3()}--${sanitizeFileName(body.fileName)}`;

      const result = await awsHelpers.initiateMultipart(
        keyFile,
        body.fileType,
        body.fileSizeBytes,
        chunkSizeBytes,
      );

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getPartUrls = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const body = req.body as IGetPartUrlsPayload;

      const validator = new Validator(req.body, {
        uploadId: "required|string",
        keyFile: "required|string",
        partNumbers: "required|array",
        "partNumbers.*": "required|integer|min:1|max:10000",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation failed",
          errors: validator.errors,
        });
      }

      if (body.partNumbers.length === 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "partNumbers must not be empty",
        });
      }
      if (body.partNumbers.length > MAX_S3_PARTS) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `partNumbers length ${body.partNumbers.length} exceeds S3 limit of ${MAX_S3_PARTS}`,
        });
      }

      const seen = new Set<number>();
      const coercedPartNumbers: number[] = [];
      for (const raw of body.partNumbers) {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > MAX_S3_PARTS) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `invalid partNumber: ${raw}`,
          });
        }
        if (seen.has(n)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `duplicate partNumber: ${n}`,
          });
        }
        seen.add(n);
        coercedPartNumbers.push(n);
      }

      const result = await awsHelpers.getPartUrls(
        body.uploadId,
        body.keyFile,
        coercedPartNumbers,
      );

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  public static completeMultipart = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const body = req.body as ICompleteMultipartPayload;

      const validator = new Validator(req.body, {
        uploadId: "required|string",
        keyFile: "required|string",
        parts: "required|array",
        "parts.*.partNumber": "required|integer|min:1|max:10000",
        "parts.*.etag": "required|string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation failed",
          errors: validator.errors,
        });
      }

      if (body.parts.length === 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "parts must not be empty",
        });
      }
      if (body.parts.length > MAX_S3_PARTS) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `parts length ${body.parts.length} exceeds S3 limit of ${MAX_S3_PARTS}`,
        });
      }

      const seen = new Set<number>();
      const sanitizedParts: ICompletedPart[] = [];
      for (const part of body.parts) {
        const n =
          typeof part.partNumber === "number"
            ? part.partNumber
            : Number(part.partNumber);
        if (!Number.isInteger(n) || n < 1 || n > MAX_S3_PARTS) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `invalid partNumber: ${part.partNumber}`,
          });
        }
        if (seen.has(n)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `duplicate partNumber: ${n}`,
          });
        }
        seen.add(n);
        if (!S3_PART_ETAG_REGEX.test(part.etag)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `invalid etag for partNumber ${n}: must be a quoted alphanumeric hash`,
          });
        }
        sanitizedParts.push({ partNumber: n, etag: part.etag });
      }

      const result = await awsHelpers.completeMultipart(
        body.uploadId,
        body.keyFile,
        sanitizedParts,
      );

      if (result === null) {
        return ErrorResponse(res, status.CONFLICT, {
          message:
            "Multipart upload no longer exists (already completed or aborted)",
          errors: { code: "MULTIPART_ALREADY_FINALIZED" },
        });
      }
      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  public static listParts = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query as unknown as IListPartsQuery;
      const validator = new Validator(req.query, {
        uploadId: "required|string",
        keyFile: "required|string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation failed",
          errors: validator.errors,
        });
      }

      const result = await awsHelpers.listParts(query.uploadId, query.keyFile);

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  public static abortMultipart = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const body = req.body as IAbortMultipartPayload;

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

      await awsHelpers.abortMultipart(body.uploadId, body.keyFile);

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: { aborted: true },
      });
    } catch (error) {
      next(error);
    }
  };
}
