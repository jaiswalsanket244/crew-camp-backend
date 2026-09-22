import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { config } from "../utils/configuration/config";

class FileService {
  private s3: S3Client;

  constructor() {
    this.s3 = new S3Client({
      credentials: {
        accessKeyId: config.S3_USER_KEY,
        secretAccessKey: config.S3_USER_SECRET,
      },
      region: config.S3_BUCKET_REGION,
    });
  }

  uploadToS3 = async (file: { name: string; data: Buffer }) => {
    const params = {
      Bucket: config.S3_BUCKET_NAME,
      Key: file.name,
      Body: file.data,
    };
    const command = new PutObjectCommand(params);
    return this.s3.send(command);
  };

  uploadMultipleFilesToS3 = async (files: { name: string; data: Buffer }[]) => {
    const uploadPromises = files.map(async (file) => {
      const params = {
        Bucket: config.S3_BUCKET_NAME,
        Key: file.name,
        Body: file.data,
      };

      try {
        const command = new PutObjectCommand(params);
        await this.s3.send(command);
      } catch (error) {
        throw new Error("Error duering s3 upload!");
      }
    });
    await Promise.all(uploadPromises);
  };

  uploadBufferToS3 = async (
    key: string,
    data: Buffer,
    contentType: string,
  ): Promise<string> => {
    const params = {
      Bucket: config.S3_BUCKET_NAME,
      Key: key,
      Body: data,
      ContentType: contentType,
    };
    await this.s3.send(new PutObjectCommand(params));

    const s3Url = `https://${config.S3_BUCKET_NAME}.s3.${config.S3_BUCKET_REGION}.amazonaws.com/${key}`;
    return config.S3_BUCKET_CDN == "NA"
      ? s3Url
      : config.S3_BUCKET_CDN + "/" + key;
  };

  deleteFromS3 = async (fileName: string) => {
    const params = {
      Bucket: config.S3_BUCKET_NAME,
      Key: fileName,
    };

    const command = new DeleteObjectCommand(params);
    return this.s3.send(command);
  };

  deleteFromS3UsingLink = async (fileUrl: string) => {
    if (!fileUrl) return;
    const urlParts = fileUrl.split("/");
    const key = urlParts.slice(3).join("/");

    return this.deleteFromS3(key);
  };

  convertToS3BucketLink = (url: string) => {
    const temp = url.split("/");
    temp[2] = `${config.S3_BUCKET_NAME}.s3.amazonaws.com`;
    return temp.join("/");
  };

  /**
   * Upload file from URL to S3 bucket
   * @param url - The URL of the file to download and upload
   * @param key - Optional custom key/filename for S3. If not provided, generates one
   * @returns Object with S3 URL and key
   */
  uploadFromUrl = async (url: string, key?: string): Promise<string> => {
    try {
      // Fetch the file from the URL
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch file from URL: ${response.status} ${response.statusText}`,
        );
      }

      // Get the content type from the response
      const contentType =
        response.headers.get("content-type") || "application/octet-stream";

      // Generate a key if not provided
      if (!key) {
        const urlParts = new URL(url);
        const pathParts = urlParts.pathname.split("/");
        const originalFilename = pathParts[pathParts.length - 1] || "file";
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(7);
        key = `uploads/${timestamp}-${randomString}-${originalFilename}`;
      }

      // Get the file data as buffer
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Upload to S3
      const params = {
        Bucket: config.S3_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      };

      const command = new PutObjectCommand(params);
      await this.s3.send(command);

      // Construct the S3 URL
      const s3Url = `https://${config.S3_BUCKET_NAME}.s3.${config.S3_BUCKET_REGION}.amazonaws.com/${key}`;

      return config.S3_BUCKET_CDN == "NA"
        ? s3Url
        : config.S3_BUCKET_CDN + "/" + key;
    } catch (error) {
      return url; // Return original URL if upload fails
    }
  };

  // FOR FUTURE REFERENCE :-->
  // uploadDBBackupToS3 = async (fileContent: any) => {
  //   const date = dayjs().format("DD-MM-YY");
  //   const filename = `${date}.archive`;
  //   const params: S3.PutObjectRequest = {
  //     Bucket: config.S3_BUCKET_NAME,
  //     Key: filename,
  //     Body: fileContent,
  //   };
  //   await this.s3.upload(params).promise();
  // };
  // uploadDBBackupToS3 = async (fileContent: any) => {
  //   const date = dayjs().format("DD-MM-YY");
  //   const filename = `${date}.archive`;
  //   const params: S3.PutObjectRequest = {
  //     Bucket: config.S3_BUCKET_NAME,
  //     Key: filename,
  //     Body: fileContent,
  //   };
  //   await this.s3.upload(params).promise();
  // };

  // deleteDBBackupFromS3 = async () => {
  //   const dateToDel = dayjs().subtract(30, "days").format("DD-MM-YY");
  //   const fileToDelete = `${dateToDel}.archive`;
  //   const params: S3.DeleteObjectRequest = {
  //     Bucket: config.S3_BUCKET_NAME,
  //     Key: fileToDelete,
  //   };
  //   await this.s3.deleteObject(params).promise();
  // };
}

export const fileService = new FileService();
