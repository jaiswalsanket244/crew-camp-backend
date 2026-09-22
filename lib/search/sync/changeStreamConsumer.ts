import {
  Comments,
  CrewsProjects,
  PostFiles,
  Posts,
  Project,
  ProjectMember,
} from "../../db";
import { emitSearchMetric } from "../emitMetric";
import { toStr } from "../reindex/projectSearchDoc";
import { applyPostsUploadsChange } from "./postUpdates";
import {
  MongoChangeEvent,
  applyCommentChange,
  applyCrewProjectChange,
  applyMemberChange,
  applyPostChange,
  applyProjectChange,
} from "./projectUpdates";
import {
  ResumeToken,
  getResumeToken,
  saveResumeToken,
} from "./resumeTokenStore";

const DEFAULT_BATCH_SIZE = 10;
const CHANGE_STREAM_HISTORY_LOST = 286; // oplog rolled past the resume token

// A temporarily-unreachable cluster is retried with backoff; everything else (malformed doc, mapping rejection, …) keeps the immediate-skip path.
const DEFAULT_MAX_ATTEMPTS = 5;
const CLIENT_UNREACHABLE_ERRORS = [
  "ConnectionError",
  "TimeoutError",
  "NoLivingConnectionsError",
];
const isClientUnreachable = (err: unknown): boolean =>
  CLIENT_UNREACHABLE_ERRORS.includes((err as { name?: string })?.name ?? "");
const defaultBackoffMs = (attempt: number): number =>
  Math.min(2 ** (attempt - 1) * 1000, 30000); // 1s, 2s, 4s, 8s, … capped at 30s
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A change event carries the resume token at `_id` plus the apply-relevant fields.
type ChangeEvent = MongoChangeEvent & { _id: ResumeToken };

// A live change stream we pull from and can close for worker drain. mongoose's Model.watch() wrapper is NOT async-iterable and has no pause/resume, so we PULL via next() (blocks, rejects on close) and gate pause consumer-side (below).
interface ChangeStreamHandle {
  next(): Promise<ChangeEvent | null>;
  close(): Promise<void> | void;
  // mongoose-wrapper internal, read only by awaitStreamReady (absent on test fakes).
  driverChangeStream?: unknown;
}

// Minimal structural shape of a watchable Mongo collection (mongoose Model.watch). Defined locally so the runner is model-agnostic without fighting Model<T> generic variance — the concrete model is cast in at the wiring.
interface ChangeStreamSource {
  watch(
    pipeline?: Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): ChangeStreamHandle;
}

interface ConsumerConfig {
  consumerKey: string; // resume-token key, e.g. "projects.changeStream"
  index: string; // ES alias name, for metric/log dims
  source: ChangeStreamSource;
  apply: (event: MongoChangeEvent) => Promise<void>;
  batchSize?: number;
  // Client-unreachable retry tuning (defaults below). backoffMs is injectable so hermetic tests run without real waits.
  retry?: { maxAttempts?: number; backoffMs?: (attempt: number) => number };
}

interface ConsumeOpts {
  consumerKey: string;
  index: string;
  apply: (event: MongoChangeEvent) => Promise<void>;
  batchSize: number;
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
}

// ── Worker lifecycle state (module-level — single-replica process) ──

// Every open change stream, so stopConsumers can close them all (graceful drain).
const openStreams = new Set<ChangeStreamHandle>();

// Pause is a CONSUMER-SIDE gate (the driver has no pause/resume): while paused, each
// consumer awaits `pauseGate` before applying the next event, so no events are applied
// and no resume token advances (tokens stay pinned). Resume/stop release the gate.
let paused = false;
let pauseGate: Promise<void> | null = null;
let releasePause: (() => void) | null = null;

// `stopping` flips on shutdown: consumers stop pulling, an in-flight backoff is
// interrupted, and a close()-induced stream rejection is treated as a clean drain.
let stopping = false;
const stopWaiters = new Set<() => void>();

const waitWhilePaused = async (): Promise<void> => {
  while (paused && pauseGate && !stopping) {
    await pauseGate;
  }
};

// sleep that resolves early when shutdown is signalled (so a long backoff can't block
// the 30s drain deadline during the exact outage the retry exists for).
const interruptibleSleep = (ms: number): Promise<void> => {
  let waiter: () => void = () => undefined;
  const interrupted = new Promise<void>((resolve) => {
    waiter = resolve;
    stopWaiters.add(waiter);
  });
  return Promise.race([sleep(ms), interrupted]).then(() => {
    stopWaiters.delete(waiter);
  });
};

// Applies one event, retrying ONLY a temporarily-unreachable cluster (connection-class errors) with exponential backoff up to maxAttempts; any other error (or exhausted retries, or shutdown mid-backoff) is logged + metered + skipped so the consumer never deadlocks.
const applyWithRetry = async (
  event: ChangeEvent,
  opts: ConsumeOpts,
): Promise<void> => {
  let attempt = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await opts.apply(event);
      return;
    } catch (err) {
      const retryable = isClientUnreachable(err);
      if (retryable && attempt < opts.maxAttempts && !stopping) {
        await interruptibleSleep(opts.backoffMs(attempt));
        if (stopping) return; // shutdown during backoff → stop retrying, skip
        attempt += 1;
        continue;
      }
      const eventType = event.operationType ?? "unknown";
      const reason = retryable
        ? "client_unreachable"
        : ((err as Error)?.message ?? "unknown");
      console.error("search.indexing.error", {
        service: "search",
        tag: "search.indexing.error",
        index: opts.index,
        event_type: eventType,
        documentId: toStr(event.documentKey?._id),
        reason,
      });
      emitSearchMetric("indexing_errors", 1, {
        index: opts.index,
        event_type: eventType,
        reason,
      });
      return; // skip + continue to the next event
    }
  }
};

// Poll (never subscribe — that would flip the driver stream into crash-prone emitter mode) for the async-populated driverChangeStream so next() won't throw on a null stream; usually a no-op since connectDB runs before watch.
const awaitStreamReady = async (stream: ChangeStreamHandle): Promise<void> => {
  if (!("driverChangeStream" in stream)) {
    return;
  }
  for (let i = 0; i < 100 && stream.driverChangeStream == null; i++) {
    await sleep(20); // up to ~2s; the connection is already open, so usually 0 iterations
  }
};

// Pull events via next(), gate on pause AFTER each event (pins the resume token while paused), skip poison events, and checkpoint the resume token per batch (plus trailing partial in finally); a close-induced rejection during shutdown is a clean drain.
const consume = async (
  stream: ChangeStreamHandle,
  opts: ConsumeOpts,
): Promise<void> => {
  await awaitStreamReady(stream);
  let batchCount = 0;
  let latestToken: ResumeToken | null = null;

  try {
    while (!stopping) {
      const event = await stream.next();
      if (event == null) {
        break; // stream exhausted / closed cleanly
      }
      await waitWhilePaused();
      if (stopping) break;
      latestToken = event._id;
      await applyWithRetry(event, opts);

      batchCount += 1;
      if (batchCount >= opts.batchSize) {
        await saveResumeToken(opts.consumerKey, latestToken);
        batchCount = 0;
      }
    }
  } catch (err) {
    if (!stopping) {
      throw err; // real error → propagate (286 reopen / fail-fast restart)
    }
    // graceful close rejected the in-flight next() → treat as drained
  } finally {
    if (batchCount > 0 && latestToken) {
      await saveResumeToken(opts.consumerKey, latestToken);
    }
  }
};

// Tails one collection's change stream and applies each event to ES, resuming from the persisted token. On a stale token (ChangeStreamHistoryLost / 286) it reopens from "now" and relies on the drift checker to reconcile the gap. Each open stream is registered for worker lifecycle and unregistered when its loop ends (graceful close or error).
export const runChangeStreamConsumer = async (
  config: ConsumerConfig,
): Promise<void> => {
  const consumeOpts: ConsumeOpts = {
    consumerKey: config.consumerKey,
    index: config.index,
    apply: config.apply,
    batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
    maxAttempts: config.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoffMs: config.retry?.backoffMs ?? defaultBackoffMs,
  };

  const openAndConsume = async (stream: ChangeStreamHandle): Promise<void> => {
    openStreams.add(stream);
    try {
      await consume(stream, consumeOpts);
    } finally {
      openStreams.delete(stream);
    }
  };

  const token = await getResumeToken(config.consumerKey);
  const baseOptions: Record<string, unknown> = { fullDocument: "updateLookup" };

  try {
    const stream = config.source.watch(
      [],
      token ? { ...baseOptions, startAfter: token } : baseOptions,
    );
    await openAndConsume(stream);
  } catch (err) {
    if (
      token &&
      (err as { code?: number })?.code === CHANGE_STREAM_HISTORY_LOST
    ) {
      console.error("search.indexing.error", {
        service: "search",
        tag: "search.indexing.error",
        index: config.index,
        event_type: "open",
        reason:
          "ChangeStreamHistoryLost — resume token stale; reopening from now",
      });
      await openAndConsume(config.source.watch([], baseOptions));
      return;
    }
    throw err;
  }
};

// Wires the Projects → projects-v1 sync stream. The PostFiles consumer reuses runChangeStreamConsumer with its own consumerKey.
export const startProjectsConsumer = (): Promise<void> =>
  runChangeStreamConsumer({
    consumerKey: "projects.changeStream",
    index: "projects",
    source: Project as unknown as ChangeStreamSource,
    apply: applyProjectChange,
  });

// Wires the PostFiles → posts_uploads-v1 sync stream. Tails `postFiles` (the index models PostFiles, not Posts); independent resume checkpoint (`posts_uploads.changeStream`), runs in parallel with the Projects consumer.
export const startPostsUploadsConsumer = (): Promise<void> =>
  runChangeStreamConsumer({
    consumerKey: "posts_uploads.changeStream",
    index: "posts_uploads",
    source: PostFiles as unknown as ChangeStreamSource,
    apply: applyPostsUploadsChange,
  });

// Related-collection denormalization consumers — keep the `projects` index's sub-counts fresh. Each tails one collection with its own resume key, all in parallel with the primary consumers. CompanyMembers is NOT watched (membersCount = projectmembers only).

// ProjectMembers → membersCount (full re-derivation).
export const startProjectMembersConsumer = (): Promise<void> =>
  runChangeStreamConsumer({
    consumerKey: "projects.related.members.changeStream",
    index: "projects",
    source: ProjectMember as unknown as ChangeStreamSource,
    apply: applyMemberChange,
  });

// CrewsProjects → crewsCount (full re-derivation).
export const startCrewsProjectsConsumer = (): Promise<void> =>
  runChangeStreamConsumer({
    consumerKey: "projects.related.crews.changeStream",
    index: "projects",
    source: CrewsProjects as unknown as ChangeStreamSource,
    apply: applyCrewProjectChange,
  });

// Comments → commentsCount (incremental partial-update).
export const startCommentsConsumer = (): Promise<void> =>
  runChangeStreamConsumer({
    consumerKey: "projects.related.comments.changeStream",
    index: "projects",
    source: Comments as unknown as ChangeStreamSource,
    apply: applyCommentChange,
  });

// Posts → postsCount + recentPosts (incremental partial-update). Distinct from the
// posts_uploads consumer above, which tails PostFiles for a different index.
export const startPostsConsumer = (): Promise<void> =>
  runChangeStreamConsumer({
    consumerKey: "projects.related.posts.changeStream",
    index: "projects",
    source: Posts as unknown as ChangeStreamSource,
    apply: applyPostChange,
  });

// ── Worker lifecycle control ──

// Launches all 6 change-stream consumers concurrently (the search-worker process hosts these until termination). Returns the per-consumer run promises so the worker can await them during graceful shutdown. (CompanyMembers is intentionally absent.)
export const startConsumers = (): { consumers: Promise<void>[] } => ({
  consumers: [
    startProjectsConsumer(),
    startPostsUploadsConsumer(),
    startProjectMembersConsumer(),
    startCrewsProjectsConsumer(),
    startCommentsConsumer(),
    startPostsConsumer(),
  ],
});

// Graceful drain: signal stop (interrupt backoffs, release the pause gate) then close every open stream. Closing rejects each in-flight next(); `consume` swallows that close-induced rejection (stopping=true), persists the trailing token in its `finally`, and resolves — so the worker can then await the consumer promises to confirm the drain. Per-stream close failures are isolated (allSettled) so one bad close can't abort the rest.
export const stopConsumers = async (): Promise<void> => {
  stopping = true;
  if (releasePause) {
    releasePause();
  }
  paused = false;
  pauseGate = null;
  releasePause = null;
  stopWaiters.forEach((wake) => wake());
  stopWaiters.clear();

  const closings: Array<Promise<unknown>> = [];
  openStreams.forEach((stream) => {
    closings.push(Promise.resolve(stream.close()).catch(() => undefined));
  });
  await Promise.allSettled(closings);
};

// Pause/resume every consumer via the consumer-side gate (SIGUSR1/SIGUSR2). While paused no events are applied → no resume-token advance → tokens stay pinned.
export const pauseConsumers = (): void => {
  if (paused) {
    return;
  }
  paused = true;
  pauseGate = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
};
export const resumeConsumers = (): void => {
  if (!paused) {
    return;
  }
  paused = false;
  if (releasePause) {
    releasePause();
  }
  pauseGate = null;
  releasePause = null;
};

// Test-only: reset module lifecycle state between cases (the real worker exits instead).
export const __resetLifecycle = (): void => {
  openStreams.clear();
  paused = false;
  pauseGate = null;
  releasePause = null;
  stopping = false;
  stopWaiters.clear();
};
