import { SearchJob, Project, PostFiles } from "../../db";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { backfillProjects } from "./backfillProjects";
import { backfillPostsUploads } from "./backfillPostsUploads";
import { swapAlias } from "./aliasSwap";
import { deployMapping } from "../cli/deployMapping";
import { getCurrentIndex, nextVersion } from "./indexVersion";

// Reindex worker. Hosted in the search-worker process (scripts/searchWorker.js) alongside the change-stream consumers. Claims the oldest PENDING SearchJob and executes it: REINDEX_FULL builds a fresh -v{N+1} index + alias-swaps; REINDEX_COMPANY backfills the company in-place into the live index (no swap). REINDEX_INCREMENTAL is not yet supported (fails fast here). Runs jobs SERIALLY.

const POLL_MS = 10000; // SEARCH_REINDEX_POLL_MS — idle poll interval
const STALE_MS = 3_600_000; // SEARCH_REINDEX_STALE_MS — RUNNING older than this is requeued on startup

let stopping = false;
let wake: (() => void) | null = null;

// Interruptible sleep: stopReindexWorker() wakes it so shutdown is prompt while idle.
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });

const log = (level: "info" | "warn" | "error", tag: string, extra: object) => {
  const payload = { service: "search", tag, ...extra };
  if (level === "warn") {
    console.warn(tag, payload);
  } else if (level === "error") {
    console.error(tag, payload);
  } else {
    console.info(tag, payload);
  }
};

interface ClaimedJob {
  _id: unknown;
  type: string;
  index: string;
  companyId?: ObjectIdType;
  since?: Date;
}

export const stopReindexWorker = (): void => {
  stopping = true;
  if (wake) {
    wake();
  }
};

// On startup, reset RUNNING jobs stranded by a crash (startedAt older than the threshold) back to PENDING so they retry; log each at warn.
export const requeueStaleJobs = async (): Promise<void> => {
  const cutoff = new Date(Date.now() - STALE_MS);
  const filter = { status: "RUNNING", startedAt: { $lt: cutoff } };
  const stale = await SearchJob.find(filter, { _id: 1 }).lean();
  if (stale.length === 0) {
    return;
  }
  await SearchJob.updateMany(filter, { $set: { status: "PENDING" } });
  for (const job of stale) {
    log("warn", "search.reindex.requeued", { jobId: String(job._id) });
  }
};

const countScope = async (
  index: string,
  companyId?: ObjectIdType,
): Promise<number> => {
  const query = companyId ? { companyId } : {};
  return index === "projects"
    ? Project.countDocuments(query)
    : PostFiles.countDocuments(query);
};

// Execute a single already-claimed (RUNNING) job. Always resolves — a job failure is recorded on the job document (FAILED), never thrown, so the worker loop survives. Exported for tests.
export const runJob = async (job: ClaimedJob): Promise<void> => {
  const startedAt = Date.now();
  try {
    if (job.type === "REINDEX_INCREMENTAL") {
      // No `since` filter yet — fail fast rather than run an unfiltered backfill.
      throw new Error("REINDEX_INCREMENTAL not yet supported");
    }

    const alias = job.index; // "projects" | "posts_uploads"
    const backfill =
      job.index === "projects" ? backfillProjects : backfillPostsUploads;
    const documentsTotal = await countScope(job.index, job.companyId);

    let documentsIndexed: number;

    if (job.type === "REINDEX_FULL") {
      // Build a fresh version, backfill everything into it, then atomically swap the alias.
      const fromIndex = await getCurrentIndex(alias);
      const toIndex = nextVersion(fromIndex, alias);
      // Crash-recovery: a prior attempt may have created toIndex then died before swapAlias (the alias never moved, so toIndex is an orphan not serving traffic). Reuse it — the backfill upserts every current doc by _id and the alias only swaps after a full successful backfill, so reuse converges to a correct index. (deployMapping throws "already exists" here; matching it avoids a permanently-FAILED retry on the create-then-crash window.)
      try {
        await deployMapping(toIndex);
      } catch (deployErr) {
        const msg = String((deployErr as Error)?.message || deployErr);
        if (!msg.includes("already exists")) {
          throw deployErr;
        }
        log("warn", "search.reindex.reusing_index", {
          jobId: String(job._id),
          index: toIndex,
        });
      }
      const result = await backfill({ targetIndex: toIndex });
      await swapAlias(alias, fromIndex, toIndex);
      documentsIndexed = result.documentsIndexed;
    } else {
      // REINDEX_COMPANY — write in place into the live index (no version bump, no swap): swapping a freshly-built single-company index would drop every other company's docs.
      const liveIndex = await getCurrentIndex(alias);
      if (!liveIndex) {
        throw new Error(
          `No live index for alias "${alias}" — run a REINDEX_FULL first.`,
        );
      }
      const result = await backfill({
        companyId: job.companyId,
        targetIndex: liveIndex,
      });
      documentsIndexed = result.documentsIndexed;
    }

    await SearchJob.findByIdAndUpdate(job._id, {
      $set: {
        status: "COMPLETED",
        completedAt: new Date(),
        progress: { documentsIndexed, documentsTotal },
      },
    });
    log("info", "search.reindex.complete", {
      jobId: String(job._id),
      documentsIndexed,
      duration: Date.now() - startedAt,
    });
  } catch (error) {
    const message = String((error as Error)?.message || error);
    await SearchJob.findByIdAndUpdate(job._id, {
      $set: { status: "FAILED", error: message, completedAt: new Date() },
    });
    log("error", "search.reindex.fail", {
      jobId: String(job._id),
      error: message,
    });
  }
};

// Claim the oldest PENDING job (FIFO via sort:{createdAt:1}) to RUNNING and run it. Returns true if a job ran. Exported for tests.
export const claimAndRunOnce = async (): Promise<boolean> => {
  const job = (await SearchJob.findOneAndUpdate(
    { status: "PENDING" },
    { $set: { status: "RUNNING", startedAt: new Date() } },
    { sort: { createdAt: 1 }, new: true },
  )) as unknown as ClaimedJob | null;
  if (!job) {
    return false;
  }
  await runJob(job);
  return true;
};

export const startReindexWorker = async (): Promise<void> => {
  stopping = false;
  try {
    await requeueStaleJobs();
  } catch (error) {
    // A startup recovery error must not crash the worker (the consumers are running).
    log("error", "search.reindex.requeue_error", {
      error: String((error as Error)?.message || error),
    });
  }

  while (!stopping) {
    let ranOne = false;
    try {
      ranOne = await claimAndRunOnce();
    } catch (error) {
      // Guards the claim/poll path; per-job failures are already handled inside runJob.
      log("error", "search.reindex.loop_error", {
        error: String((error as Error)?.message || error),
      });
    }
    if (stopping) {
      break;
    }
    if (!ranOne) {
      await sleep(POLL_MS); // idle → wait before polling again
    }
  }
};
