import mongoose from "mongoose";
import * as fs from "fs";
import * as path from "path";
import { config } from "../utils/configuration/config";
import { ErrorLogs } from "../db";

// Connection tuning. Keeps server selection short so a replica-set election
// surfaces quickly instead of buffering for the full default window.
const CONNECT_OPTIONS: mongoose.ConnectOptions = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 10000,
  maxPoolSize: 100,
  retryWrites: true,
  retryReads: true,
};

const MAX_RETRIES = 20;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let listenersRegistered = false;

let connectDBInProgress = false;

const outageState = {
  disconnectedLogged: false,
  errorLogged: false,
};

export interface DbConnectionLog {
  errorType: string;
  message: string;
  stack?: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

// FIFO buffer for connection events that occur while the DB is unreachable.
// Drained automatically on (1) reconnect, (2) successful connectDB(),
// (3) the hourly cron, and (4) opportunistically inside pushLog when the
// buffer reaches FLUSH_THRESHOLD.
const MAX_BUFFERED_LOGS = 1000;
const FLUSH_THRESHOLD = 100; // try opportunistic flush when buffer reaches this
const KEEP_AFTER_FAILURE = 50; // on flush failure / DB down, retain this many newest
const bufferedLogs: DbConnectionLog[] = [];
let opportunisticFlushInFlight = false;

const pushLog = (log: DbConnectionLog) => {
  bufferedLogs.push(log);
  if (bufferedLogs.length > MAX_BUFFERED_LOGS) {
    bufferedLogs.shift();
  }
  if (bufferedLogs.length >= FLUSH_THRESHOLD && !opportunisticFlushInFlight) {
    void tryOpportunisticFlush();
  }
};

// Triggered when the buffer reaches FLUSH_THRESHOLD. Attempts to persist all
// buffered entries; on any failure (DB unreachable or insertMany error),
// keeps only the KEEP_AFTER_FAILURE most-recent entries so memory stays
// bounded and the buffer is biased toward recent events.
const tryOpportunisticFlush = async (): Promise<void> => {
  opportunisticFlushInFlight = true;
  try {
    if (mongoose.connection.readyState !== 1) {
      if (bufferedLogs.length > KEEP_AFTER_FAILURE) {
        const dropped = bufferedLogs.length - KEEP_AFTER_FAILURE;
        bufferedLogs.splice(0, dropped);
      }
      return;
    }
    const pending = bufferedLogs.splice(0, bufferedLogs.length);
    try {
      await ErrorLogs.insertMany(pending, { ordered: false });
    } catch (error) {
      if (bufferedLogs.length > KEEP_AFTER_FAILURE) {
        bufferedLogs.splice(0, bufferedLogs.length - KEEP_AFTER_FAILURE);
      }
      pushLog({
        errorType: "DB_OPPORTUNISTIC_FLUSH_FAILED",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        metadata: {
          droppedCount: pending.length,
          source: "tryOpportunisticFlush",
          ...(error instanceof Error ? { name: error.name } : {}),
        },
        occurredAt: new Date(),
      });
    }
  } finally {
    opportunisticFlushInFlight = false;
  }
};

export const drainPendingDbLogs = (): DbConnectionLog[] => {
  return bufferedLogs.splice(0, bufferedLogs.length);
};

export const getPendingDbLogCount = (): number => bufferedLogs.length;

// Public helper for code outside this module (e.g. the cron) to add an entry
// to the buffer without touching the internal pushLog.
export const recordDbConnectionEvent = (params: {
  errorType: string;
  message: string;
  error?: Error;
  metadata?: Record<string, unknown>;
}) => {
  pushLog({
    errorType: params.errorType,
    message: params.message,
    stack: params.error?.stack,
    metadata: {
      ...(params.metadata || {}),
      ...(params.error?.name ? { name: params.error.name } : {}),
    },
    occurredAt: new Date(),
  });
};

// On-disk persistence so buffered events survive a process restart (e.g. when
// connectDB() exhausts retries and exits). Capped at MAX_PERSISTED_LOGS most
// recent entries to keep the file small and bias toward recent events.
const PERSIST_FILE_PATH = path.join(process.cwd(), ".db-event-buffer.json");
const MAX_PERSISTED_LOGS = 50;
let exitHandlerRegistered = false;

const persistBufferToDisk = () => {
  try {
    if (bufferedLogs.length === 0) {
      if (fs.existsSync(PERSIST_FILE_PATH)) {
        fs.unlinkSync(PERSIST_FILE_PATH);
      }
      return;
    }
    const toPersist = bufferedLogs.slice(-MAX_PERSISTED_LOGS);
    fs.writeFileSync(
      PERSIST_FILE_PATH,
      JSON.stringify(toPersist, null, 2),
      "utf8",
    );
  } catch (err) {
    console.error("Failed to persist DB event buffer to disk:");
  }
};

const restoreBufferFromDisk = () => {
  try {
    if (!fs.existsSync(PERSIST_FILE_PATH)) return;
    const raw = fs.readFileSync(PERSIST_FILE_PATH, "utf8");
    const parsed: DbConnectionLog[] = JSON.parse(raw);
    const restored = parsed.map((entry) => ({
      ...entry,
      occurredAt: new Date(entry.occurredAt),
    }));
    bufferedLogs.unshift(...restored);
    fs.unlinkSync(PERSIST_FILE_PATH);
  } catch (err) {
    pushLog({
      errorType: "DB_RESTORE_FAILED",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      metadata: {
        source: "restoreBufferFromDisk",
        filePath: PERSIST_FILE_PATH,
        ...(err instanceof Error ? { name: err.name } : {}),
      },
      occurredAt: new Date(),
    });
  }
};

const registerExitHandler = () => {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", persistBufferToDisk);
};

export const flushBufferedDbLogs = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 1) return;
  if (bufferedLogs.length === 0) return;
  const pending = bufferedLogs.splice(0, bufferedLogs.length);
  try {
    await ErrorLogs.insertMany(pending, { ordered: false });
  } catch (error) {
    bufferedLogs.unshift(...pending);
    pushLog({
      errorType: "DB_FLUSH_FAILED",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      metadata: {
        source: "flushBufferedDbLogs",
        pendingCount: pending.length,
        ...(error instanceof Error ? { name: error.name } : {}),
      },
      occurredAt: new Date(),
    });
  }
};

// Logs topology changes (e.g. failovers) so a lost connection is visible in
// prod logs instead of silently buffering until a manual restart.
const registerConnectionListeners = () => {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const connection = mongoose.connection;

  connection.on("disconnected", () => {
    console.warn("MongoDB disconnected — driver will attempt to reconnect");
    if (connectDBInProgress) return;
    if (outageState.disconnectedLogged) return;
    outageState.disconnectedLogged = true;
    pushLog({
      errorType: "DB_DISCONNECTED",
      message: "MongoDB connection dropped",
      metadata: { readyState: connection.readyState },
      occurredAt: new Date(),
    });
  });

  connection.on("reconnected", () => {
    console.log("MongoDB reconnected");
    outageState.disconnectedLogged = false;
    outageState.errorLogged = false;
    pushLog({
      errorType: "DB_RECONNECTED",
      message: "MongoDB connection re-established by driver",
      metadata: { readyState: connection.readyState },
      occurredAt: new Date(),
    });
    void flushBufferedDbLogs();
  });

  connection.on("error", (err: Error) => {
    console.error(`MongoDB connection error: ${err}`);
    if (connectDBInProgress) return;
    if (outageState.errorLogged) return;
    outageState.errorLogged = true;
    pushLog({
      errorType: "DB_CONNECTION_ERROR",
      message: err?.message || String(err),
      stack: err?.stack,
      metadata: {
        readyState: connection.readyState,
        name: err?.name,
      },
      occurredAt: new Date(),
    });
  });
};

// Connects with exponential backoff. After the first successful connection the
// driver auto-reconnects on transient drops; retries here cover the initial
// connect so a momentary outage at boot does not start a server with a dead DB.

export const connectDB = async () => {
  const dbPath = config.DB_PATH;
  registerConnectionListeners();
  registerExitHandler();
  restoreBufferFromDisk();

  let lastFailureLog: DbConnectionLog | null = null;
  connectDBInProgress = true;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(dbPath, CONNECT_OPTIONS);
      console.log(`Connected to DB ${dbPath}`);
      connectDBInProgress = false;
      if (lastFailureLog) {
        pushLog(lastFailureLog);
      }
      await flushBufferedDbLogs();
      return;
    } catch (err) {
      const wait = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      console.error(
        `MongoDB connect attempt ${attempt}/${MAX_RETRIES} failed: ${err}. Retrying in ${wait}ms`,
      );
      const error = err as Error;
      lastFailureLog = {
        errorType: "DB_CONNECT_ATTEMPT_FAILED",
        message: error?.message || String(err),
        stack: error?.stack,
        metadata: {
          attempt,
          maxRetries: MAX_RETRIES,
          waitMs: wait,
          name: error?.name,
        },
        occurredAt: new Date(),
      };

      if (attempt === MAX_RETRIES) {
        pushLog(lastFailureLog);
        process.exit(1);
      }

      await delay(wait);
    }
  }
};
