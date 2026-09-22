import {
  SQSClient,
  SendMessageCommand,
  SendMessageCommandInput,
  SendMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import { Types } from "mongoose";
import { config } from "../utils/configuration/config";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

interface DownloadJobFile {
  name: string;
  url: string;
}

interface DownloadJobPayload {
  jobId: string;
  zipName: string;
  files: DownloadJobFile[];
  userEmail: string;
  batchInfo?: {
    current: number;
    total: number;
  };
}

interface DownloadJobResult {
  jobId: string;
  batches: number;
  messageIds?: string[];
}

interface SQSServiceConfig {
  region: string;
  queueUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxMessageSizeKB?: number;
  filesPerBatch?: number;
}

/**
 * AWS SQS Service Class
 * Handles SQS operations with automatic chunking for large payloads
 */
class AWSSQSService {
  private static instance: AWSSQSService;
  private client: SQSClient;
  private queueUrl: string;
  private maxMessageSizeBytes: number;
  private defaultFilesPerBatch: number;

  private constructor(config: SQSServiceConfig) {
    this.client = new SQSClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.queueUrl = config.queueUrl;
    // Use 250 KB as safe limit (SQS max is 256 KB)
    this.maxMessageSizeBytes = (config.maxMessageSizeKB || 250) * 1024;
    this.defaultFilesPerBatch = config.filesPerBatch || 100;
  }

  /**
   * Get singleton instance of AWSSQSService
   */
  public static getInstance(): AWSSQSService {
    if (!AWSSQSService.instance) {
      AWSSQSService.instance = new AWSSQSService({
        region: config.S3_BUCKET_REGION,
        queueUrl: config.SQS_URL,
        accessKeyId: config.S3_USER_KEY,
        secretAccessKey: config.S3_USER_SECRET,
      });
    }
    return AWSSQSService.instance;
  }

  /**
   * Calculate approximate size of a message payload in bytes
   */
  private calculateMessageSize(payload: any): number {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  }

  /**
   * Split files into chunks that fit within SQS message size limits
   */
  private chunkFilesBySize(
    files: DownloadJobFile[],
    jobId: string,
    userEmail: string,
  ): DownloadJobFile[][] {
    const chunks: DownloadJobFile[][] = [];
    let currentChunk: DownloadJobFile[] = [];
    let currentSize = 0;

    // Calculate base payload size (without files array)
    const basePayload: DownloadJobPayload = {
      jobId,
      zipName: `downloads/${jobId}.zip`,
      files: [],
      userEmail,
      batchInfo: { current: 0, total: 0 },
    };
    const basePayloadSize = this.calculateMessageSize(basePayload);

    for (const file of files) {
      const fileSize = this.calculateMessageSize(file);

      // If adding this file would exceed the limit, start a new chunk
      if (
        currentSize + fileSize + basePayloadSize > this.maxMessageSizeBytes &&
        currentChunk.length > 0
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }

      currentChunk.push(file);
      currentSize += fileSize;
    }

    // Add the last chunk if it has files
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Split files into chunks by count
   */
  private chunkFilesByCount(
    files: DownloadJobFile[],
    filesPerBatch: number,
  ): DownloadJobFile[][] {
    const chunks: DownloadJobFile[][] = [];

    for (let i = 0; i < files.length; i += filesPerBatch) {
      chunks.push(files.slice(i, i + filesPerBatch));
    }

    return chunks;
  }

  /**
   * Send a single message to SQS
   */
  private async sendMessage(
    params: SendMessageCommandInput,
  ): Promise<SendMessageCommandOutput> {
    try {
      const command = new SendMessageCommand(params);
      return await this.client.send(command);
    } catch (error: any) {
      console.error("Failed to send SQS message:", error);
      throw new Error(`Failed to send SQS message: ${error.message || error}`);
    }
  }

  /**
   * Create download job(s) in SQS, handling large file lists by splitting into multiple messages
   * For backward compatibility, this still sends multiple messages
   */
  public async createDownloadJob(
    files: DownloadJobFile[],
    userEmail: string,
  ): Promise<DownloadJobResult> {
    const jobId = new Types.ObjectId().toString();

    // Handle empty file list
    if (files.length === 0) {
      console.warn("No files to download");
      return { jobId, batches: 0 };
    }

    // Split files into chunks that fit within SQS message size limits
    const fileChunks = this.chunkFilesBySize(files, jobId, userEmail);
    const totalBatches = fileChunks.length;

    try {
      const messageIds: string[] = [];

      // Send each chunk as a separate SQS message
      const sendPromises = fileChunks.map(async (chunk, index) => {
        const batchNumber = index + 1;

        const payload: DownloadJobPayload = {
          jobId,
          zipName: `downloads/${jobId}.zip`,
          files: chunk,
          userEmail,
          batchInfo: {
            current: batchNumber,
            total: totalBatches,
          },
        };

        // Verify message size before sending
        const messageSize = this.calculateMessageSize(payload);
        if (messageSize > 256 * 1024) {
          throw new Error(
            `Batch ${batchNumber} exceeds SQS message size limit: ${messageSize} bytes`,
          );
        }

        const res = await this.sendMessage({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(payload),
          MessageAttributes: {
            jobId: {
              DataType: "String",
              StringValue: jobId,
            },
            batchNumber: {
              DataType: "Number",
              StringValue: batchNumber.toString(),
            },
            totalBatches: {
              DataType: "Number",
              StringValue: totalBatches.toString(),
            },
          },
        });

        return res.MessageId;
      });

      // Wait for all batches to be sent
      const results = await Promise.all(sendPromises);
      results.forEach((id) => {
        if (id) messageIds.push(id);
      });

      return {
        jobId,
        batches: totalBatches,
        messageIds,
      };
    } catch (error: any) {
      console.error("Failed to create download job:", error);
      throw new Error(
        `Failed to create download job: ${error.message || error}`,
      );
    }
  }

  /**
   * Create a single download job using S3 manifest for large file lists
   * This sends only ONE SQS message regardless of file count
   */
  public async createSingleDownloadJob(
    files: DownloadJobFile[],
    userEmail: string,
  ): Promise<DownloadJobResult> {
    const jobId = new Types.ObjectId().toString();

    // Handle empty file list
    if (files.length === 0) {
      console.warn("No files to download");
      return { jobId, batches: 0 };
    }

    try {
      // For large file lists, store manifest in S3
      const estimatedSize = this.calculateMessageSize({ files });

      let payload: any;

      if (estimatedSize > 200 * 1024) {
        // If over 200KB, use S3 manifest
        const s3Client = new S3Client({
          region: config.S3_BUCKET_REGION, // Use the correct region config
          credentials: {
            accessKeyId: config.S3_USER_KEY,
            secretAccessKey: config.S3_USER_SECRET,
          },
        });

        // Create manifest in S3
        const manifestKey = `download-manifests/${jobId}.json`;
        const manifest = {
          jobId,
          files,
          totalFiles: files.length,
          createdAt: new Date().toISOString(),
        };

        // Use the appropriate bucket for storing manifests
        const bucketName = config.S3_DOWNLOAD_BUCKET || config.S3_BUCKET_NAME;

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: manifestKey,
            Body: JSON.stringify(manifest),
            ContentType: "application/json",
          }),
        );

        // Send SQS message with S3 reference
        payload = {
          jobId,
          zipName: `downloads/${jobId}.zip`,
          userEmail,
          manifestLocation: {
            bucket: bucketName,
            key: manifestKey,
          },
          totalFiles: files.length,
          useManifest: true,
        };
      } else {
        // Small enough to fit in SQS message directly
        payload = {
          jobId,
          zipName: `downloads/${jobId}.zip`,
          files,
          userEmail,
          useManifest: false,
        };
      }

      // Send single SQS message
      const res = await this.sendMessage({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(payload),
        MessageAttributes: {
          jobId: {
            DataType: "String",
            StringValue: jobId,
          },
          jobType: {
            DataType: "String",
            StringValue: payload.useManifest ? "manifest" : "direct",
          },
        },
      });

      return {
        jobId,
        batches: 1, // Always 1 batch with this approach
        messageIds: res.MessageId ? [res.MessageId] : [],
      };
    } catch (error: any) {
      console.error("Failed to create single download job:", error);
      throw new Error(
        `Failed to create download job: ${error.message || error}`,
      );
    }
  }

  /**
   * Create download job with file count limit per batch
   * Use this if you prefer limiting by file count rather than message size
   */
  public async createDownloadJobWithFileLimit(
    files: DownloadJobFile[],
    userEmail: string,
    filesPerBatch?: number,
  ): Promise<DownloadJobResult> {
    const jobId = new Types.ObjectId().toString();
    const batchSize = filesPerBatch || this.defaultFilesPerBatch;

    // Split files into batches
    const batches = this.chunkFilesByCount(files, batchSize);

    try {
      const messageIds: string[] = [];

      const sendPromises = batches.map(async (batch, index) => {
        const batchNumber = index + 1;

        const payload: DownloadJobPayload = {
          jobId,
          zipName: `downloads/${jobId}.zip`,
          files: batch,
          userEmail,
          batchInfo: {
            current: batchNumber,
            total: batches.length,
          },
        };

        const res = await this.sendMessage({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(payload),
        });

        return res.MessageId;
      });

      const results = await Promise.all(sendPromises);
      results.forEach((id) => {
        if (id) messageIds.push(id);
      });

      return {
        jobId,
        batches: batches.length,
        messageIds,
      };
    } catch (error: any) {
      console.error("Failed to create download job with file limit:", error);
      throw new Error(
        `Failed to create download job: ${error.message || error}`,
      );
    }
  }

  /**
   * Get service configuration and status
   */
  public getServiceInfo(): {
    queueUrl: string;
    region: string;
    maxMessageSizeKB: number;
    defaultFilesPerBatch: number;
  } {
    return {
      queueUrl: this.queueUrl,
      region: config.S3_BUCKET_REGION,
      maxMessageSizeKB: this.maxMessageSizeBytes / 1024,
      defaultFilesPerBatch: this.defaultFilesPerBatch,
    };
  }

  /**
   * Legacy static method for backward compatibility
   * @deprecated Use instance method createDownloadJob instead
   */
  public static async createDownloadJobLegacy(
    files: { name: string; url: string }[],
    userEmail: string,
  ): Promise<string> {
    const instance = AWSSQSService.getInstance();
    const result = await instance.createDownloadJob(files, userEmail);

    return result.jobId;
  }
}

// Export the class for direct usage
export { AWSSQSService };

// Export default for convenient importing
export default AWSSQSService;

// Legacy function export for backward compatibility
// This maintains the existing API for code that uses createDownloadJob directly
export const createDownloadJob = AWSSQSService.createDownloadJobLegacy;
