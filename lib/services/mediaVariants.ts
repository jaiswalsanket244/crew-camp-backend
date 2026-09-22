import { execFile } from "child_process";
import * as sharpModule from "sharp";
import ffmpegStatic = require("ffmpeg-static");
import { PostFiles } from "../db";
import { fileService } from "./awsBucket";
import { IMediaVariantCandidate } from "../utils/interfaces/files";

// Both deps expose their real value as the CJS module itself, but their
// bundled typings declare ESM default exports — hence the casts.
const sharp = sharpModule as unknown as typeof sharpModule.default;
const ffmpegPath = ffmpegStatic as unknown as string | null;

type VariantKind = "quickView" | "thumbnail";

interface VariantJob {
  fileId: string;
  sourceUrl: string;
  kind: VariantKind;
}

const MAX_CONCURRENT_JOBS = 2;
const MAX_QUEUE_SIZE = 300;
const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const FAILURE_CACHE_PRUNE_SIZE = 2000;
const MAX_SOURCE_IMAGE_BYTES = 60 * 1024 * 1024;
const QUICK_VIEW_MAX_EDGE = 1600;
const QUICK_VIEW_JPEG_QUALITY = 80;
const THUMBNAIL_MAX_EDGE = 1280;
const FFMPEG_TIMEOUT_MS = 60 * 1000;
const FFMPEG_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

/**
 * Lazily generates display-sized variants for post files, triggered from
 * read paths (e.g. GET /posts/scroll). Images get a resized JPEG persisted
 * to `quickView`; videos get a poster frame persisted to `thumbnail`.
 * Work runs in-process on a small concurrency-limited queue; clients fall
 * back to `url` (images) or on-device generation (videos) until populated.
 */
class MediaVariantsService {
  private queue: VariantJob[] = [];
  private activeJobs = 0;
  // `${fileId}:${kind}` entries currently queued or running.
  private tracked = new Set<string>();
  // Recent failures, so repeated scrolls don't retry broken sources hot.
  private failedAt = new Map<string, number>();

  public enqueueCandidates = (
    files: (IMediaVariantCandidate | null | undefined)[],
  ): void => {
    for (const file of files) {
      if (!file || !file._id || !file.url) continue;
      if (!/^https?:\/\//i.test(file.url)) continue;

      const fileType = file.fileType || "";
      if (fileType.startsWith("image") && !file.quickView) {
        this.enqueue({
          fileId: String(file._id),
          sourceUrl: file.url,
          kind: "quickView",
        });
      } else if (fileType.startsWith("video") && !file.thumbnail) {
        this.enqueue({
          fileId: String(file._id),
          sourceUrl: file.url,
          kind: "thumbnail",
        });
      }
    }
  };

  private enqueue = (job: VariantJob): void => {
    const key = `${job.fileId}:${job.kind}`;
    if (this.tracked.has(key)) return;

    const lastFailure = this.failedAt.get(key);
    if (lastFailure && Date.now() - lastFailure < FAILURE_COOLDOWN_MS) return;

    if (this.queue.length >= MAX_QUEUE_SIZE) return;

    this.tracked.add(key);
    this.queue.push(job);
    this.drain();
  };

  private drain = (): void => {
    while (this.activeJobs < MAX_CONCURRENT_JOBS && this.queue.length) {
      const job = this.queue.shift();
      if (!job) break;
      this.activeJobs += 1;
      void this.run(job);
    }
  };

  private run = async (job: VariantJob): Promise<void> => {
    const key = `${job.fileId}:${job.kind}`;
    try {
      await this.processJob(job);
      this.failedAt.delete(key);
    } catch (error) {
      this.rememberFailure(key);
      console.error(
        `media variant ${job.kind} generation failed for file ${job.fileId}:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.activeJobs -= 1;
      this.tracked.delete(key);
      this.drain();
    }
  };

  private processJob = async (job: VariantJob): Promise<void> => {
    const buffer =
      job.kind === "quickView"
        ? await this.buildQuickView(job.sourceUrl)
        : await this.buildVideoPoster(job.sourceUrl);

    const prefix = job.kind === "quickView" ? "quickviews" : "video-thumbnails";
    const url = await fileService.uploadBufferToS3(
      `${prefix}/${job.fileId}.jpg`,
      buffer,
      "image/jpeg",
    );

    // Fill only if still empty — another request/instance may have won the race.
    await PostFiles.updateOne(
      { _id: job.fileId, [job.kind]: { $in: [null, ""] } },
      { $set: { [job.kind]: url } },
    );
  };

  private buildQuickView = async (sourceUrl: string): Promise<Buffer> => {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`source fetch failed with status ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error(`source image too large: ${contentLength} bytes`);
    }

    const original = Buffer.from(await response.arrayBuffer());
    return sharp(original)
      .rotate() // bake EXIF orientation into the pixels
      .resize(QUICK_VIEW_MAX_EDGE, QUICK_VIEW_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: QUICK_VIEW_JPEG_QUALITY })
      .toBuffer();
  };

  private buildVideoPoster = async (sourceUrl: string): Promise<Buffer> => {
    // Grab a frame ~1s in to skip black lead-ins; clips shorter than that
    // produce no output, so retry from the very first frame.
    try {
      return await this.extractFrame(sourceUrl, 1);
    } catch {
      return this.extractFrame(sourceUrl, 0);
    }
  };

  // ffmpeg reads S3 over HTTPS with range requests, so only the bytes needed
  // for one frame are downloaded — the full video is never fetched.
  private extractFrame = (
    sourceUrl: string,
    seekSeconds: number,
  ): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      if (!ffmpegPath) {
        return reject(new Error("ffmpeg binary unavailable"));
      }
      const scale = `scale='min(iw,${THUMBNAIL_MAX_EDGE})':'min(ih,${THUMBNAIL_MAX_EDGE})':force_original_aspect_ratio=decrease`;
      const args = [
        "-ss",
        String(seekSeconds),
        "-i",
        sourceUrl,
        "-frames:v",
        "1",
        "-vf",
        scale,
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "3",
        "pipe:1",
      ];
      execFile(
        ffmpegPath,
        args,
        {
          encoding: "buffer",
          timeout: FFMPEG_TIMEOUT_MS,
          maxBuffer: FFMPEG_MAX_OUTPUT_BYTES,
        },
        (error, stdout) => {
          if (error) return reject(error);
          if (!stdout || stdout.length === 0) {
            return reject(new Error("ffmpeg produced no frame"));
          }
          resolve(stdout);
        },
      );
    });

  private rememberFailure = (key: string): void => {
    if (this.failedAt.size >= FAILURE_CACHE_PRUNE_SIZE) {
      const now = Date.now();
      const expired: string[] = [];
      this.failedAt.forEach((ts, k) => {
        if (now - ts >= FAILURE_COOLDOWN_MS) expired.push(k);
      });
      expired.forEach((k) => this.failedAt.delete(k));
      // Still saturated with fresh failures — reset rather than grow unbounded.
      if (this.failedAt.size >= FAILURE_CACHE_PRUNE_SIZE) this.failedAt.clear();
    }
    this.failedAt.set(key, Date.now());
  };
}

export const mediaVariantsService = new MediaVariantsService();
