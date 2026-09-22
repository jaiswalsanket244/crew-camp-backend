import { CacheTTL } from "../utils/interfaces/cache";
import { HealthDimension, HealthMetric } from "../utils/interfaces/health";

export const WORST_LIMIT = 10;

export const PER_PERSON_PAGES = 12;

export const SESSIONS_RELEASE_CAP = 25;

export const TELEMETRY_V2 = "telemetryVersion:2";

export const UPLOAD_FLOW = `${TELEMETRY_V2} flow:upload`;

export const CRASH_QUERY = "error.unhandled:true";

export const CAMERA_FLOW = `${TELEMETRY_V2} flow:camera`;

export const CAMERA_NAME_MATCH =
  "(culprit:*amera* OR title:*amera* OR title:*AVCapture* " +
  "OR culprit:*AVCapture* OR title:*ImageCapture*)";
export const CAMERA_ISSUE_QUERY =
  `((${CAMERA_FLOW} result:failed) ` +
  `OR (${CRASH_QUERY} ${CAMERA_NAME_MATCH}))`;

export const PHOTOS_LOST_QUERY = `${TELEMETRY_V2} flow:dataIntegrity result:lost`;

export const STUCK_SNAPSHOT_QUERY = `${TELEMETRY_V2} flow:queue result:stuck`;

export const STUCK_POST_QUERY = `${TELEMETRY_V2} flow:queue result:stuckPost`;

export const STUCK_THRESHOLDS = [8, 24, 48, 72];

export const STUCK_LOOKBACK = "90d";

export const TAG = {
  category: "failureCategory",
  stage: "stage",
  code: "failureCode",
  networkClass: "networkClass",
  netType: "netType",
  attemptKind: "attemptKind",
  filesInPost: "filesInPost",
} as const;

export const FAILURE_CATEGORY = {
  transient: "transient",
  staleResource: "staleResource",
  blocked: "blocked",
  permanent: "permanent",
} as const;

export const NOT_MEASURED_NOTE =
  "Waiting for app telemetry v2 — not measured yet";

export const DIMENSION_FIELD: Record<HealthDimension, string> = {
  user: "user.id",
  device: "device",
  os: "os",
  network: "networkClass",
  connectivity: "connectivity",
  company: "companyId",
  reason: "reason",
  stage: "stage",
  release: "release",
  jsBundle: "jsBundle",
  appState: "appState",
  queueWait: "queueWait",
  payloadSize: "payloadSize",
  isMultipart: "isMultipart",
  resumedAfterKill: "resumedAfterKill",
  httpStatus: "httpStatus",
  awsErrorCode: "awsErrorCode",
};

export const METRIC_QUERY: Record<HealthMetric, string> = {
  upload: `${TELEMETRY_V2} flow:upload`,
  drafts: `${TELEMETRY_V2} flow:draft`,
  stuck: STUCK_SNAPSHOT_QUERY,
  errors: "level:[error,fatal]",
  crashes: "level:fatal",
};

export const SUBJECT_FIELD: Record<string, string> = {
  user: "user.id",
  device: "device",
  company: "companyId",
};

export const HEALTH_CACHE_VERSION = "v37";

export const CACHE_PREFIX = `health:${HEALTH_CACHE_VERSION}:`;

export const CACHE_TTL = {
  overview: CacheTTL.DEFAULT,
  breakdown: CacheTTL.DEFAULT,
  subject: CacheTTL.SHORT * 2,
  releases: CacheTTL.LONG,
};

export const RANGES = ["24h", "7d", "14d", "30d", "90d"];
export const PLATFORMS = ["ios", "android", "all"];
export const DIMENSIONS = [
  "user",
  "device",
  "os",
  "network",
  "connectivity",
  "company",
  "reason",
  "stage",
  "release",
  "jsBundle",
  "appState",
  "queueWait",
  "payloadSize",
  "isMultipart",
  "resumedAfterKill",
  "httpStatus",
  "awsErrorCode",
];
export const METRICS = ["upload", "drafts", "stuck", "errors", "crashes"];
export const SUBJECT_TYPES = ["user", "device", "company"];
export const SCOPES = ["summary", "detail", "all"];
