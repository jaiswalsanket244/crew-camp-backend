import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  ListPartsCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../utils/configuration/config";
import {
  ICompletedPart,
  IGetPartUrlsResponse,
  IInitiateMultipartResponse,
  IListPartsResponse,
  IPartUrlEntry,
  IStagedPart,
} from "../../utils/interfaces/multipartUpload";
import { IStaleMultipartUpload } from "../../utils/interfaces/externalApi";

import {
  MAX_PARALLEL_PRESIGNS,
  MULTIPART_PART_URL_TTL_SECONDS,
} from "../../utils/constants/constants";

export class AwsHelpers {
  private s3Client: S3Client;

  constructor() {
    this.s3Client = new S3Client({
      region: config.S3_BUCKET_REGION,
      credentials: {
        accessKeyId: config.S3_USER_KEY,
        secretAccessKey: config.S3_USER_SECRET,
      },
    });
  }

  public getSignedUrl = async (
    keyFile: string,
    fileType: string,
    contentLength?: number,
  ) => {
    const myBucket = config.S3_BUCKET_NAME;
    const contentType = fileType;
    const signedUrlExpireSeconds = 60 * 60 * 2;

    // Passing ContentLength puts `content-length` in the URL's SignedHeaders,
    // so S3 itself rejects a body of any other size. That makes the size cap a
    // real limit rather than a validator the client could simply ignore.
    const command = new PutObjectCommand({
      Bucket: myBucket,
      Key: keyFile,
      ContentType: contentType,
      ...(contentLength ? { ContentLength: contentLength } : {}),
    });
    const signedUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: signedUrlExpireSeconds,
    });

    const returnUrl =
      config.S3_BUCKET_CDN == "NA" ? "" : config.S3_BUCKET_CDN + "/" + keyFile;

    return { url: signedUrl, keyFile, returnUrl };
  };

  public initiateMultipart = async (
    keyFile: string,
    fileType: string,
    fileSizeBytes: number,
    chunkSizeBytes: number,
  ): Promise<IInitiateMultipartResponse> => {
    const command = new CreateMultipartUploadCommand({
      Bucket: config.S3_BUCKET_NAME,
      Key: keyFile,
      ContentType: fileType,
    });
    const response = await this.s3Client.send(command);
    if (!response.UploadId) {
      throw new Error("S3 did not return an UploadId");
    }

    return {
      uploadId: response.UploadId,
      keyFile,
      chunkSizeBytes,
      bucketName: config.S3_BUCKET_NAME,
    };
  };

  public getPartUrls = async (
    uploadId: string,
    keyFile: string,
    partNumbers: number[],
  ): Promise<IGetPartUrlsResponse> => {
    const urls: IPartUrlEntry[] = new Array(partNumbers.length);

    for (let i = 0; i < partNumbers.length; i += MAX_PARALLEL_PRESIGNS) {
      const batch = partNumbers.slice(i, i + MAX_PARALLEL_PRESIGNS);
      const presigned = await Promise.all(
        batch.map(async (partNumber, batchIndex) => {
          const command = new UploadPartCommand({
            Bucket: config.S3_BUCKET_NAME,
            Key: keyFile,
            UploadId: uploadId,
            PartNumber: partNumber,
          });
          const url = await getSignedUrl(this.s3Client, command, {
            expiresIn: MULTIPART_PART_URL_TTL_SECONDS,
          });
          return { index: i + batchIndex, entry: { partNumber, url } };
        }),
      );
      for (const { index, entry } of presigned) {
        urls[index] = entry;
      }
    }

    return {
      urls,
      expiresInSeconds: MULTIPART_PART_URL_TTL_SECONDS,
    };
  };

  public completeMultipart = async (
    uploadId: string,
    keyFile: string,
    parts: ICompletedPart[],
  ) => {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    const command = new CompleteMultipartUploadCommand({
      Bucket: config.S3_BUCKET_NAME,
      Key: keyFile,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sorted.map((p) => ({
          PartNumber: p.partNumber,
          ETag: p.etag,
        })),
      },
    });

    let response;
    try {
      response = await this.s3Client.send(command);
    } catch (err) {
      const error = err as { name?: string; Code?: string };
      if (error?.name === "NoSuchUpload" || error?.Code === "NoSuchUpload") {
        return null;
      }
      throw err;
    }

    const location =
      response.Location ||
      `https://${config.S3_BUCKET_NAME}.s3.${config.S3_BUCKET_REGION}.amazonaws.com/${keyFile}`;
    const returnUrl =
      config.S3_BUCKET_CDN == "NA" ? "" : config.S3_BUCKET_CDN + "/" + keyFile;

    return { location, returnUrl, keyFile };
  };

  public listParts = async (
    uploadId: string,
    keyFile: string,
  ): Promise<IListPartsResponse> => {
    const collected: IStagedPart[] = [];
    let partNumberMarker: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      try {
        const command = new ListPartsCommand({
          Bucket: config.S3_BUCKET_NAME,
          Key: keyFile,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        });
        const response = await this.s3Client.send(command);

        for (const part of response.Parts ?? []) {
          if (part.PartNumber == null || part.ETag == null) continue;
          collected.push({
            partNumber: part.PartNumber,
            etag: part.ETag,
            sizeBytes: part.Size ?? 0,
          });
        }

        if (!response.IsTruncated || !response.NextPartNumberMarker) {
          hasMore = false;
        } else {
          partNumberMarker = response.NextPartNumberMarker;
        }
      } catch (err) {
        const error = err as { name?: string; Code?: string };
        if (error?.name === "NoSuchUpload" || error?.Code === "NoSuchUpload") {
          return { parts: [] };
        }
        throw err;
      }
    }

    collected.sort((a, b) => a.partNumber - b.partNumber);
    return { parts: collected };
  };

  public abortMultipart = async (uploadId: string, keyFile: string) => {
    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: config.S3_BUCKET_NAME,
        Key: keyFile,
        UploadId: uploadId,
      });
      await this.s3Client.send(command);
    } catch (err) {
      const error = err as { name?: string; Code?: string };
      if (error?.name === "NoSuchUpload" || error?.Code === "NoSuchUpload") {
        return;
      }
      throw err;
    }
  };

  /**
   * Multipart uploads S3 still holds staged parts for, initiated before
   * `cutoff`. S3 bills for those parts until the upload is completed or
   * aborted, and an upload that was abandoned never becomes an object any
   * other cleanup path can see.
   */
  public listStaleMultipartUploads = async (
    cutoff: Date,
    limit: number,
  ): Promise<IStaleMultipartUpload[]> => {
    const stale: IStaleMultipartUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    let hasMore = true;

    while (hasMore && stale.length < limit) {
      const response = await this.s3Client.send(
        new ListMultipartUploadsCommand({
          Bucket: config.S3_BUCKET_NAME,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );

      for (const upload of response.Uploads ?? []) {
        if (!upload.UploadId || !upload.Key) continue;
        if (upload.Initiated && upload.Initiated >= cutoff) continue;

        stale.push({
          uploadId: upload.UploadId,
          keyFile: upload.Key,
          initiatedAt: upload.Initiated,
        });

        if (stale.length >= limit) break;
      }

      hasMore = Boolean(response.IsTruncated);
      keyMarker = response.NextKeyMarker;
      uploadIdMarker = response.NextUploadIdMarker;
    }

    return stale;
  };
}

export const awsHelpers = new AwsHelpers();
