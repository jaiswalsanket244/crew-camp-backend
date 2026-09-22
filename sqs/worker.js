import dotenv from "dotenv";
dotenv.config();

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sgMail from "@sendgrid/mail";

import archiver from "archiver";
import axios from "axios";
import { PassThrough } from "stream";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import os from "os";

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Check if we have explicit credentials (for local development)
// Otherwise, the SDK will use IAM role credentials automatically (for ECS)
const awsConfig = {
  region: process.env.AWS_REGION || "us-east-1",
};

// Only add credentials if they're explicitly provided (for local development)
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  awsConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
  console.log("Using explicit AWS credentials from environment variables");
} else {
  console.log(
    "No explicit credentials found, will use IAM role or instance profile",
  );
}

const sqs = new SQSClient(awsConfig);
const s3 = new S3Client(awsConfig);

const QUEUE_URL = process.env.SQS_URL;
const BUCKET = process.env.S3_BUCKET;

async function sendEmail(to, url) {
  await sgMail.send({
    to,
    from: process.env.SENDGRID_USER_EMAIL,
    subject: "Your download is ready 🎉",
    html: `
     <h2>Your files are ready</h2>
     <p>Click below to download:</p>
     <a href="${url}" clicktracking="off">Download ZIP</a>
     <p>Expires in 24 hours</p>
     <p style="color: #666; font-size: 12px;">If the button doesn't work, copy and paste this link:<br>${url}</p>
   `,
    trackingSettings: {
      clickTracking: {
        enable: false, // Disable click tracking for this email
        enableText: false,
      },
      openTracking: {
        enable: false, // Also disable open tracking if you want
      },
    },
  });
}

async function fetchManifestFromS3(bucket, key) {
  console.log(`Fetching manifest from S3: s3://${bucket}/${key}`);

  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await s3.send(command);
    const manifestString = await response.Body.transformToString();
    const manifest = JSON.parse(manifestString);

    console.log(
      `Manifest loaded: ${manifest.totalFiles || manifest.files?.length || 0} files`,
    );
    return manifest;
  } catch (error) {
    console.error(`Failed to fetch manifest from S3:`, error);
    throw new Error(`Failed to fetch manifest: ${error.message}`);
  }
}

async function processJob(job) {
  let files, zipName, userEmail;

  // Check if this job uses a manifest file from S3
  if (job.useManifest && job.manifestLocation) {
    console.log(
      `Job uses S3 manifest: ${job.manifestLocation.bucket}/${job.manifestLocation.key}`,
    );

    // Fetch the manifest from S3
    const manifest = await fetchManifestFromS3(
      job.manifestLocation.bucket,
      job.manifestLocation.key,
    );

    // Extract files from manifest
    files = manifest.files;
    zipName = job.zipName;
    userEmail = job.userEmail;

    console.log(`Manifest loaded with ${files.length} files for ${userEmail}`);
  } else {
    // Direct mode - files are in the job payload
    files = job.files;
    zipName = job.zipName;
    userEmail = job.userEmail;
    console.log(`Direct mode: ${files.length} files for ${userEmail}`);
  }

  console.log("Starting job for:", userEmail, zipName);
  console.log(`Processing ${files.length} files`);

  // Validate input
  if (!files || !Array.isArray(files) || files.length === 0) {
    throw new Error("Invalid job: no files provided");
  }

  if (!zipName || !userEmail) {
    throw new Error("Invalid job: missing zipName or userEmail");
  }

  // Validate each file has required properties
  for (const file of files) {
    if (!file.url || !file.name) {
      console.error("Invalid file object:", file);
      throw new Error(
        `Invalid file object: missing url or name. Got: ${JSON.stringify(file)}`,
      );
    }
  }

  // Create a PassThrough stream for streaming upload
  const streamPassThrough = new PassThrough();

  // Create archive with streaming
  const archive = archiver("zip", {
    store: true, // No compression for faster processing
    highWaterMark: 1024 * 1024, // 1MB chunks
  });

  // Handle archive errors
  archive.on("error", (err) => {
    console.error("Archive error:", err);
    streamPassThrough.destroy(err);
    throw err;
  });

  // Pipe archive directly to the PassThrough stream
  archive.pipe(streamPassThrough);

  // Start multipart upload to S3 while archiving
  const parallelUploads3 = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: zipName,
      Body: streamPassThrough,
      ContentType: "application/zip",
    },
    // Multipart upload configuration for large files
    queueSize: 4, // 4 concurrent parts
    partSize: 1024 * 1024 * 10, // 10MB parts (minimum is 5MB for multipart)
    leavePartsOnError: false,
  });

  // Monitor upload progress
  parallelUploads3.on("httpUploadProgress", (progress) => {
    if (progress.loaded && progress.total) {
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      console.log(
        `Upload progress: ${percentage}% (${progress.loaded}/${progress.total} bytes)`,
      );
    } else if (progress.loaded) {
      console.log(`Uploaded ${progress.loaded} bytes...`);
    }
  });

  // Start the upload (non-blocking)
  const uploadPromise = parallelUploads3.done();

  console.log("Downloading and streaming files to archive:");
  let successCount = 0;
  let errorCount = 0;

  // Create temporary directory for large file downloads
  const tempDir = path.join(os.tmpdir(), `zip-job-${Date.now()}`);
  await fsPromises.mkdir(tempDir, { recursive: true });

  try {
    for (const file of files) {
      try {
        console.log(`Processing: ${file.name} from ${file.url}`);

        // For large files, stream directly to avoid memory issues
        const response = await axios({
          method: "get",
          url: file.url,
          responseType: "stream",
          timeout: 300000, // 5 minute timeout for large files
          validateStatus: (status) => status < 500,
          maxRedirects: 5,
        });

        if (response.status >= 400) {
          console.error(
            `Failed to download ${file.name}: HTTP ${response.status}`,
          );
          errorCount++;
          continue;
        }

        // Get content length if available
        const contentLength = response.headers["content-length"];
        if (contentLength) {
          console.log(
            `Downloading ${file.name}: ${(contentLength / 1024 / 1024).toFixed(2)} MB`,
          );
        }

        // For very large files (>100MB), download to temp file first
        if (contentLength && parseInt(contentLength) > 100 * 1024 * 1024) {
          const tempFilePath = path.join(tempDir, file.name);
          const writeStream = fs.createWriteStream(tempFilePath);

          await new Promise((resolve, reject) => {
            response.data.pipe(writeStream);
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
            response.data.on("error", reject);
          });

          // Add file from disk to archive
          archive.file(tempFilePath, { name: file.name });
          console.log(`Added ${file.name} to archive (from temp file)`);
        } else {
          // For smaller files, stream directly to archive
          archive.append(response.data, { name: file.name });
          console.log(`Added ${file.name} to archive (streamed)`);
        }

        successCount++;
      } catch (downloadError) {
        console.error(`Error downloading ${file.name}:`, downloadError.message);
        errorCount++;
      }
    }

    console.log(
      `Downloaded ${successCount} files successfully, ${errorCount} errors`,
    );

    // Finalize the archive
    await archive.finalize();
    console.log("Archive finalized, waiting for upload to complete...");

    // Wait for the upload to complete
    const uploadResult = await uploadPromise;
    console.log(
      "Upload completed successfully:",
      uploadResult.Location || uploadResult.Key,
    );
  } finally {
    // Clean up temporary directory
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
      console.log("Cleaned up temporary files");
    } catch (cleanupError) {
      console.error("Error cleaning up temp directory:", cleanupError);
    }
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: zipName,
    }),
    { expiresIn: 86400 },
  );

  try {
    console.log(`Sending email to ${userEmail} with download link...`, url);
    await sendEmail(userEmail, url);
  } catch (err) {
    console.error("Email failed:", err);
  }
}

async function poll() {
  console.log("Starting SQS polling...");
  console.log("Queue URL:", QUEUE_URL);

  while (true) {
    console.log("Polling for messages...");
    const data = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        WaitTimeSeconds: 20,
      }),
    );

    if (!data.Messages) continue;

    for (const msg of data.Messages) {
      console.log("msg received:", msg.Body);
      try {
        console.log("Parsing job...");
        const job = JSON.parse(msg.Body);
        console.log("Processing job:", job);
        await processJob(job);
        console.log("Job processed successfully");
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: msg.ReceiptHandle,
          }),
        );
      } catch (err) {
        console.error("Job failed:", err);
      }
    }
  }
}

poll();
