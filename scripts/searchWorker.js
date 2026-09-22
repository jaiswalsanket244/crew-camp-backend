// Long-running entry point: the search-worker process.
//
//   node scripts/searchWorker.js
//
// Hosts all 6 change-stream consumers (projects, posts_uploads, project-members,
// crews-projects, comments, posts) until termination.
// SINGLE REPLICA ONLY — change-stream cursors must be singleton; two workers
// would double-process events and race resume tokens. The reindex worker
// is hosted in this same process. Requires the COMPILED output in server/
// (run `tsc` first); `config` loads .env via its own dotenv.config(). This wrapper
// never imports the opensearch package directly — the boundary stays in lib/search/.
//
// Lifecycle:
//   SIGTERM/SIGINT → graceful drain (close streams → persist resume tokens) → exit 0
//                    within 30s, else log search.worker.shutdown_timeout → exit 1
//   SIGUSR1        → pause indexing (resume tokens pinned at the last ACK'd position)
//   SIGUSR2        → resume indexing

const SHUTDOWN_TIMEOUT_MS = 30000;

const log = (level, tag, extra) =>
  console[level](tag, { service: "search", tag, ...extra });

// Drains the consumers and exits. Self-contained (never rejects): the 30s deadline
// wraps the WHOLE drain (stopConsumers + awaiting the consumers), and any error forces
// a non-zero exit. Exported (with an injectable timeout) for tests.
const gracefulShutdown = async (consumers, lifecycle, timeoutMs) => {
  log("info", "search.worker.shutdown", {});
  let timer;
  try {
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const drain = (async () => {
      await lifecycle.stopConsumers();
      await Promise.allSettled(consumers);
      return "drained";
    })();
    const outcome = await Promise.race([drain, deadline]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      log("error", "search.worker.shutdown_timeout", {
        reason: `shutdown exceeded ${timeoutMs}ms`,
      });
      return process.exit(1);
    }
    return process.exit(0);
  } catch (err) {
    clearTimeout(timer);
    log("error", "search.worker.shutdown_timeout", {
      reason: (err && err.message) || "shutdown error",
    });
    return process.exit(1);
  }
};

const main = async () => {
  // Connect to Mongo first — change streams require a replica-set connection.
  const { connectDB } = require("../server/services/connectDB");
  await connectDB();

  const lifecycle = require("../server/search/sync/changeStreamConsumer");
  const { consumers } = lifecycle.startConsumers();

  // Reindex worker — the same process hosts both the change-stream consumers and the
  // reindex loop. Its promise resolves once stopReindexWorker() flips the loop's shutdown flag.
  const reindexLifecycle = require("../server/search/reindex/reindexWorker");
  consumers.push(reindexLifecycle.startReindexWorker());
  log("info", "search.worker.started", { consumers: consumers.length });

  // Fail-fast: if any single consumer dies unrecoverably (a non-286 stream error),
  // exit non-zero so ECS/k8s restarts the worker (single replica). Not coupled via
  // Promise.all — a graceful shutdown resolves the consumers cleanly (no exit here).
  consumers.forEach((p) =>
    p.catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return; // ignore repeated SIGTERM/SIGINT
    }
    shuttingDown = true;
    // Stop the reindex loop so its promise (in `consumers`) resolves and the drain can complete.
    reindexLifecycle.stopReindexWorker();
    gracefulShutdown(consumers, lifecycle, SHUTDOWN_TIMEOUT_MS);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGUSR1", () => {
    lifecycle.pauseConsumers();
    log("info", "search.worker.paused", {});
  });
  process.on("SIGUSR2", () => {
    lifecycle.resumeConsumers();
    log("info", "search.worker.resumed", {});
  });

  // main resolves after wiring; the open change streams + Mongo connection + signal
  // listeners keep the process alive until a signal drives gracefulShutdown.
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { gracefulShutdown };
