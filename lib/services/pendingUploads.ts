import { Types } from "mongoose";
import { Files, PendingUpload, PostFiles, Project, ProjectNotes } from "../db";
import { awsHelpers } from "../routes/aws/helpers";
import { fileService } from "./awsBucket";
import { IPendingUploadRecord } from "../utils/interfaces/externalApi";

// How long an upload may sit unclaimed before it is treated as abandoned.
// Generous, because a caller may legitimately upload a batch of photos and
// create the post some time later.
export const ORPHAN_GRACE_HOURS = 24;

// Claimed rows are kept briefly for traceability, then pruned.
const CLAIMED_RETENTION_DAYS = 7;

// Ceilings per run so a backlog can't turn the nightly job into an all-night
// job; whatever is left is picked up tomorrow.
const MAX_ORPHANS_PER_RUN = 500;
const MAX_STALE_MULTIPART_PER_RUN = 200;

export interface IOrphanSweepSummary {
  examined: number;
  deleted: number;
  stillReferenced: number;
  failures: number;
  claimedPruned: number;
  multipartAborted: number;
}

/**
 * Tracking for upload URLs handed out by the external API, and the nightly
 * sweep that removes the ones nothing ever used.
 */
export class PendingUploadService {
  public static record = async (
    upload: IPendingUploadRecord,
  ): Promise<void> => {
    try {
      // Upsert rather than insert: a caller retrying a presign for the same key
      // should not fail on the unique index.
      await PendingUpload.updateOne(
        { keyFile: upload.keyFile },
        { $set: upload },
        { upsert: true },
      );
    } catch (error) {
      // Tracking is best-effort — never fail an upload because bookkeeping
      // failed. The cost is an object the reaper won't know about.
      console.error("PendingUpload: failed to record upload:", error);
    }
  };

  public static recordMany = async (
    uploads: IPendingUploadRecord[],
  ): Promise<void> => {
    if (!uploads.length) return;

    try {
      await PendingUpload.bulkWrite(
        uploads.map((upload) => ({
          updateOne: {
            filter: { keyFile: upload.keyFile },
            update: { $set: upload },
            upsert: true,
          },
        })),
      );
    } catch (error) {
      console.error("PendingUpload: failed to record uploads:", error);
    }
  };

  public static findOwned = async (
    keyFile: string,
    companyId: Types.ObjectId,
  ) => {
    return PendingUpload.findOne({ keyFile, companyId }).lean();
  };

  public static remove = async (keyFile: string): Promise<void> => {
    try {
      await PendingUpload.deleteOne({ keyFile });
    } catch (error) {
      console.error("PendingUpload: failed to remove upload:", error);
    }
  };

  /**
   * Marks the objects behind these urls as in use. Called whenever an external
   * write stores a url, so the reaper leaves them alone.
   *
   * Matches on the S3 key parsed out of the url, which is what makes this work
   * regardless of whether the caller sent the CDN url, a bucket url, or the
   * bare key.
   */
  public static claim = async (urls: string[]): Promise<void> => {
    const keys = urls
      .map((url) => PendingUploadService.extractKey(url))
      .filter((key): key is string => Boolean(key));

    if (!keys.length) return;

    try {
      await PendingUpload.updateMany(
        { keyFile: { $in: keys }, claimedAt: { $exists: false } },
        { $set: { claimedAt: new Date() } },
      );
    } catch (error) {
      console.error("PendingUpload: failed to claim uploads:", error);
    }
  };

  // Accepts a full url or a bare key and returns the S3 object key.
  private static extractKey = (url: string): string | null => {
    if (!url || typeof url !== "string") return null;
    const trimmed = url.trim();
    if (!trimmed) return null;

    if (!/^https?:\/\//i.test(trimmed)) {
      return trimmed.replace(/^\/+/, "");
    }

    // Everything after the host, matching how deleteFromS3UsingLink derives it.
    const key = trimmed.split("/").slice(3).join("/");
    return key ? key.split("?")[0] : null;
  };

  /**
   * Deletes objects that were signed for but never referenced.
   *
   * Only rows this service created are considered — internal app uploads are
   * never tracked, so the sweep cannot reach a key it did not hand out. Each
   * candidate is still checked against every collection a /v1 write can put a
   * url into before anything is deleted; the tracking row is the candidate
   * list, not the authority.
   */
  public static sweepOrphans = async (): Promise<IOrphanSweepSummary> => {
    const summary: IOrphanSweepSummary = {
      examined: 0,
      deleted: 0,
      stillReferenced: 0,
      failures: 0,
      claimedPruned: 0,
      multipartAborted: 0,
    };

    const cutoff = new Date(Date.now() - ORPHAN_GRACE_HOURS * 60 * 60 * 1000);

    const candidates = await PendingUpload.find(
      { claimedAt: { $exists: false }, createdAt: { $lt: cutoff } },
      { keyFile: 1, url: 1, uploadId: 1 },
    )
      .limit(MAX_ORPHANS_PER_RUN)
      .lean<
        {
          _id: Types.ObjectId;
          keyFile: string;
          url?: string;
          uploadId?: string;
        }[]
      >();

    for (const candidate of candidates) {
      summary.examined += 1;

      try {
        const referenced = await PendingUploadService.isReferenced(
          candidate.keyFile,
        );

        if (referenced) {
          // Something used it without going through a tracked write path.
          // Claim it so it is never reconsidered.
          summary.stillReferenced += 1;
          await PendingUpload.updateOne(
            { _id: candidate._id },
            { $set: { claimedAt: new Date() } },
          );
          continue;
        }

        // An upload that was started but never completed has no object to
        // delete — abort it so S3 stops holding the staged parts.
        if (candidate.uploadId) {
          await awsHelpers
            .abortMultipart(candidate.uploadId, candidate.keyFile)
            .catch(() => undefined);
        }

        await fileService.deleteFromS3(candidate.keyFile);
        await PendingUpload.deleteOne({ _id: candidate._id });
        summary.deleted += 1;
      } catch (error) {
        summary.failures += 1;
        console.error(
          `PendingUpload: failed to reap ${candidate.keyFile}:`,
          error,
        );
      }
    }

    summary.claimedPruned = await PendingUploadService.pruneClaimed();

    return summary;
  };

  /**
   * True if any collection a /v1 write can reach stores this key. Defensive
   * second opinion before deletion — a missed reference here would delete a
   * live photo.
   */
  private static isReferenced = async (keyFile: string): Promise<boolean> => {
    // Anchored suffix match: the key is the tail of whatever url was stored,
    // whichever host prefix the client used.
    const suffix = new RegExp(
      `${keyFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    );

    const [postFile, note, project, file] = await Promise.all([
      PostFiles.exists({ url: suffix }),
      ProjectNotes.exists({ "files.url": suffix }),
      Project.exists({ projectImage: suffix }),
      Files.exists({ url: suffix }),
    ]);

    return Boolean(postFile || note || project || file);
  };

  private static pruneClaimed = async (): Promise<number> => {
    const cutoff = new Date(
      Date.now() - CLAIMED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      const result = await PendingUpload.deleteMany({
        claimedAt: { $exists: true, $lt: cutoff },
      });
      return result.deletedCount ?? 0;
    } catch (error) {
      console.error("PendingUpload: failed to prune claimed rows:", error);
      return 0;
    }
  };

  /**
   * Aborts multipart uploads S3 is still holding parts for. Covers uploads
   * started outside the tracked path, and any whose tracking row was lost.
   */
  public static abortStaleMultipartUploads = async (): Promise<number> => {
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_HOURS * 60 * 60 * 1000);

    try {
      const stale = await awsHelpers.listStaleMultipartUploads(
        cutoff,
        MAX_STALE_MULTIPART_PER_RUN,
      );

      let aborted = 0;
      for (const upload of stale) {
        try {
          await awsHelpers.abortMultipart(upload.uploadId, upload.keyFile);
          aborted += 1;
        } catch (error) {
          console.error(
            `PendingUpload: failed to abort multipart ${upload.keyFile}:`,
            error,
          );
        }
      }

      return aborted;
    } catch (error) {
      console.error("PendingUpload: failed to list multipart uploads:", error);
      return 0;
    }
  };
}
