export type HealthRange = "24h" | "7d" | "14d" | "30d" | "90d";

export type HealthPlatform = "ios" | "android" | "all";

export type HealthDimension =
  | "user"
  | "device"
  | "os"
  | "network"
  | "connectivity"
  | "company"
  | "reason"
  | "stage"
  | "release"
  | "jsBundle"
  | "appState"
  | "queueWait"
  | "payloadSize"
  | "isMultipart"
  | "resumedAfterKill"
  | "httpStatus"
  | "awsErrorCode";

export type HealthMetric = "upload" | "drafts" | "stuck" | "errors" | "crashes";

export type HealthSubjectType = "user" | "device" | "company";

export interface IHealthFilters {
  range: HealthRange;
  platform: HealthPlatform;
  release?: string;
  network?: string;
  connectivity?: string;
  company?: string;
  jsBundle?: string;
  failureCode?: string;
  failureStage?: string;
}

/** One row of a Sentry Discover table query. */
export interface ISentryEventRow {
  [field: string]: string | number | null;
}

export interface ISentryEventsResult {
  rows: ISentryEventRow[];
  nextCursor: string | null;
}

export interface ISentryEventsQuery {
  /** Fields to select; any non-aggregate field becomes a group key. Max 20. */
  fields: string[];
  query: string;
  statsPeriod: string;
  sort?: string;
  perPage?: number;
  cursor?: string;
  dataset?: string;
}

export interface ISentrySessionsGroup {
  by: { [key: string]: string };
  totals: { [metric: string]: number };
  series: { [metric: string]: number[] };
}

export interface ISentrySessionsResult {
  intervals: string[];
  groups: ISentrySessionsGroup[];
}

export interface ISentrySessionsQuery {
  fields: string[];
  groupBy?: string[];
  statsPeriod: string;
  interval?: string;
  /** Release / environment only — this endpoint knows nothing else. */
  query?: string;
}

/** One app release seen in the data, with the platform it ran on. */
export interface IReleaseOption {
  release: string;
  platform: string;
  /** Most recent event from this release — used to resolve "latest". */
  lastSeenAt: string;
  events: number;
}

export interface IReleasesResponse {
  /** Newest-first within each platform. */
  byPlatform: { [platform: string]: IReleaseOption[] };
  /** The release to preselect for each platform. */
  latestByPlatform: { [platform: string]: string };
  meta: IHealthMeta;
}

export interface IHealthTile {
  value: number | null;
  numerator?: number;
  denominator?: number;
  asOf?: string;
  note?: string;
  footnote?: string;
}

export interface IResultCounts {
  started: number;
  success: number;
  failure: number;
}

export interface IUploadDayPoint {
  day: string;
  started: number;
  success: number;
  failure: number;
  permanent: number;
  retrying: number;
  inProgress: number;
  uniqueUsers: number;
}

export interface IDraftDayPoint {
  day: string;
  created: number;
  posted: number;
  discarded: number;
}

export interface ICrashFreeDay {
  day: string;
  rate: number;
  users: number;
  sessions: number;
}

export interface ICrashFreeRelease {
  release: string;
  crashFreeRate: number;
  users: number;
  sessions: number;
  series: ICrashFreeDay[];
}

export interface IPhotoLossCause {
  reason: string;
  photos: number;
  posts: number;
  users: number;
}

export interface IStageFailure {
  stage: string;
  posts: number;
}

export interface IFailureReason {
  category: string;
  stage: string;
  reason: string;
  count: number;
  users: number;
  share: number;
}

export interface INetworkSplit {
  networkClass: string;
  started: number;
  success: number;
  failures: number;
  users: number;
  successRate: number | null;
  meanTotalSec: number | null;
  medianTotalSec: number | null;
  /** How many successful uploads carried a timing. `0` means no data yet. */
  timingSamples: number;
}

/** Uploads split by connection type — same rules as INetworkSplit. */
export interface IConnectivitySplit {
  connectivity: string;
  started: number;
  success: number;
  failures: number;
  users: number;
  successRate: number | null;
  meanTotalSec: number | null;
  medianTotalSec: number | null;
  /** How many successful uploads carried a timing. `0` means no data yet. */
  timingSamples: number;
}

export interface IStuckAgeBucket {
  bucket: string;
  devices: number;
}

export interface IPostCreationSummary {
  total: number;
  createdOffline: number;
  createdOfflineShare: number;
  neverReachedUpload: number;
}

export interface IWorstUser {
  userId: string;
  name: string | null;
  companyName: string | null;
  started: number;
  success: number;
  failed: number;
  successRate: number;
  activeDays: number;
  uploadsPerActiveDay: number;
  lastSeenAt: string | null;
}

/** One row of the per-user upload list. */
export interface IUserUploadRow {
  userId: string;
  name: string | null;
  email: string | null;
  companyName: string | null;
  started: number;
  success: number;
  failed: number;
  /**
   * Of `failed`, the ones that can never recover — the photos are gone.
   *
   * Without this the list could only rank by success rate, so someone whose
   * uploads all retry and land looked identical to someone who has actually
   * lost photos. Same badge, entirely different problem.
   */
  permanentFailed: number;
  inProgress: number;
  successRate: number;
  activeDays: number;
  uploadsPerActiveDay: number;
  lastSeenAt: string | null;
}

export interface IUserUploadList {
  rows: IUserUploadRow[];
  total: number;
  searched: boolean;
  meta: IHealthMeta;
}

export interface IStuckUploadRow {
  postId: string;
  userId: string | null;
  name: string | null;
  email: string | null;
  companyName: string | null;
  stuckHours: number;
  threshold: number;
  stage: string | null;
  phase: string | null;
  filesInPost: number;
  filesSynced: number;
  filesUploadedNotSynced: number;
  filesPending: number;
  filesFailed: number;
  device: string | null;
  reportedAt: string | null;
}

export interface IStuckUploadList {
  rows: IStuckUploadRow[];
  total: number;
  byStage: { stage: string; posts: number }[];
  nextCursor: string | null;
  meta: IHealthMeta;
}

export interface IHealthMeta {
  cachedAt: string;
  staleSources: string[];
}

export type HealthScope = "summary" | "detail" | "all";

/** Tiles only. Everything a reader needs before they read a number. */
export interface IHealthSummary {
  filters: IHealthFilters;
  tiles: {
    uploadSuccess: IHealthTile;
    crashFreeUsers: IHealthTile;
    stuckPosts: IHealthTile;
    activeUploaders: IHealthTile;
    activeDevices: IHealthTile;
    draftsWaiting: IHealthTile;
    photosLostForever: IHealthTile;
    postToServerSeconds: IHealthTile;
    firstTrySuccess: IHealthTile;
  };
  meta: IHealthMeta;
}

/** The panels below the tiles. */
export interface IHealthDetail {
  filters: IHealthFilters;
  series: {
    uploadSuccessByDay: IUploadDayPoint[];
    draftsByDay: IDraftDayPoint[];
  };
  breakdowns: {
    failuresByStage: IStageFailure[];
    photosLostByCause: IPhotoLossCause[];
    failureReasons: IFailureReason[];
    byNetwork: INetworkSplit[];
    byConnectivity: IConnectivitySplit[];
    stuckByAge: IStuckAgeBucket[];
    postCreation: IPostCreationSummary;
  };
  worst: {
    users: IWorstUser[];
  };
  meta: IHealthMeta;
}

export interface IHealthOverview {
  filters: IHealthFilters;
  tiles: {
    uploadSuccess: IHealthTile;
    crashFreeUsers: IHealthTile;
    stuckPosts: IHealthTile;
    activeUploaders: IHealthTile;
    activeDevices: IHealthTile;
    draftsWaiting: IHealthTile;
    photosLostForever: IHealthTile;
    postToServerSeconds: IHealthTile;
    firstTrySuccess: IHealthTile;
  };
  series: {
    uploadSuccessByDay: IUploadDayPoint[];
    draftsByDay: IDraftDayPoint[];
  };
  breakdowns: {
    failuresByStage: IStageFailure[];
    photosLostByCause: IPhotoLossCause[];
    failureReasons: IFailureReason[];
    byNetwork: INetworkSplit[];
    byConnectivity: IConnectivitySplit[];
    stuckByAge: IStuckAgeBucket[];
    postCreation: IPostCreationSummary;
  };
  worst: {
    users: IWorstUser[];
  };
  meta: IHealthMeta;
}

export interface IBreakdownRow {
  key: string;
  label: string;
  started: number;
  success: number;
  failed: number;
  successRate: number;
  usersAffected: number;
  lastSeenAt: string | null;
  activeDays?: number;
  uploadsPerActiveDay?: number;
}

export interface IHealthBreakdown {
  dimension: HealthDimension;
  metric: HealthMetric;
  rows: IBreakdownRow[];
  nextCursor: string | null;
  meta: IHealthMeta;
}

export interface ISubjectUploadStats {
  started: number;
  success: number;
  failed: number;
  successRate: number | null;
  vsFleetAverage: number | null;
}

export interface ISubjectDraftStats {
  created: number;
  posted: number;
  discarded: number;
  openDrafts: number | null;
  openDraftsAt: string | null;
  /** Age of the oldest open draft, in hours, from the same snapshot. */
  oldestOpenHours: number | null;
  photosStranded: number;
}

export interface ISubjectStuckStats {
  /** Last snapshot this device sent. NOT "right now" — render it in the UI. */
  asOf: string | null;
  pendingCount: number;
  stuckOver8h: number;
  oldestAgeH: number | null;
  oldestCreatedAt: string | null;
  photosPending: number;
  connectivityAtSnapshot: string | null;
  oldestPostId: string | null;
}

/**
 * Device conditions at the moment of an upload.
 *
 * Read from a SINGLE event's context. Sentry does not index these as tags, so
 * they can never be grouped, filtered or charted — only shown for one event.
 */
export interface IUploadDeviceContext {
  batteryLevel: number | null;
  charging: boolean | null;
  online: boolean | null;
  freeMemoryBytes: number | null;
  totalMemoryBytes: number | null;
  freeStorageBytes: number | null;
  totalStorageBytes: number | null;
  screenResolution: string | null;
  model: string | null;
  deviceClass: string | null;
  osName: string | null;
  osVersion: string | null;
  osBuild: string | null;
  simulator: boolean | null;
  lowPowerMode: boolean | null;
  thermalState: string | null;
}

export interface IUploadBreadcrumb {
  timestamp: string | null;
  category: string | null;
  level: string | null;
  message: string | null;
  data: { [key: string]: unknown } | null;
}

/** One handset model that hit a particular crash. */
export interface ICrashImpactDevice {
  model: string;
  os: string;
  crashes: number;
  usersAffected: number;
}

export interface ICrashImpactUser {
  userId: string;
  crashes: number;
  lastSeenAt: string | null;
}

export interface ICrashImpactResponse {
  issueId: string;
  totals: {
    crashes: number;
    devicesAffected: number;
    usersAffected: number;
  };
  /** Worst handsets first, capped. */
  devices: ICrashImpactDevice[];
  /** Worst-hit people first, capped. */
  users: ICrashImpactUser[];
  meta: IHealthMeta;
}

export interface IUploadAttempt {
  eventId: string | null;
  at: string | null;
  result: string;
  attempt: string | null;
  attemptKind: string | null;
  category: string | null;
  stage: string | null;
  reason: string | null;
  httpStatus: string | null;
  connectivity: string | null;
  networkClass: string | null;
}

export interface IUploadPostHistory {
  postId: string;
  attempts: IUploadAttempt[];
  totalAttempts: number;
  failedAttempts: number;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  outcome: string;
  truncated: boolean;
}

export interface IUploadEventDetail {
  eventId: string;
  groupId: string | null;
  at: string | null;
  message: string | null;
  level: string | null;
  tags: { [key: string]: string };
  extra: { [key: string]: unknown };
  device: IUploadDeviceContext;
  exception: ICrashException | null;
  user: { id: string | null; name: string | null; companyName: string | null };
  breadcrumbs: IUploadBreadcrumb[];
  hasStackTrace: boolean;
  history: IUploadPostHistory | null;
  sentryUrl: string;
}

export interface ISubjectEvent {
  eventId: string | null;
  /**
   * Bucketed gap between the person pressing Post and the upload running.
   *
   * The row's `startedAt` is when the *upload* began, which on a post that sat
   * for days is nowhere near when the photos were taken — and that gap is the
   * likeliest explanation for `local:missingFile`.
   */
  waited: string | null;
  category: string | null;
  postId: string | null;
  at: string;
  startedAt: string | null;
  status: string;
  result: string;
  stage: string | null;
  reason: string | null;
  connectivity: string | null;
  networkClass: string | null;
  device: string | null;
  photos: number | null;
  seconds: number | null;
}

export interface ISubjectDevice {
  model: string;
  os: string;
  deviceClass: string | null;
  osBuild: string | null;
  rooted: string | null;
  started: number;
  success: number;
  failures: number;
  successRate: number | null;
  lastSeenAt: string | null;
}

export interface ISubjectMixEntry {
  key: string;
  started: number;
  success: number;
  failures: number;
  successRate: number | null;
}

export interface ISubjectRelease {
  release: string;
  jsBundle: string | null;
  started: number;
  lastSeenAt: string | null;
}

export interface IHealthSubject {
  subject: {
    type: HealthSubjectType;
    id: string;
    name: string | null;
    companyName: string | null;
    role: string | null;
  };
  upload: ISubjectUploadStats;
  drafts: ISubjectDraftStats;
  posts: {
    created: number;
    createdOffline: number;
    neverReachedUpload: number;
  };
  stuck: ISubjectStuckStats;
  failureReasons: IFailureReason[];
  devices: ISubjectDevice[];
  connectivityMix: ISubjectMixEntry[];
  networkMix: ISubjectMixEntry[];
  releases: ISubjectRelease[];
  photosLost: number;
  uploadByDay: IUploadDayPoint[];
  recentEvents: ISubjectEvent[];
  crashes: { count: number };
  sentryUrl: string;
  meta: IHealthMeta;
}

export interface ICrashedDeviceRow {
  device: string;
  os: string;
  crashes: number;
  usersAffected: number;
  lastCrashAt: string | null;
}

export interface ICrashedDevicesResponse {
  rows: ICrashedDeviceRow[];
  nextCursor: string | null;
  meta: IHealthMeta;
}

/** One crash, as Sentry recorded it. */
export interface ICrashEvent {
  eventId: string | null;
  userId: string | null;
  userName: string | null;
  at: string;
  title: string;
  issue: string | null;
  culprit: string | null;
  release: string | null;
  os: string | null;
  device: string | null;
  deviceClass: string | null;
  mechanism: string | null;
  level: string | null;
  sentryUrl: string;
}

export interface IDeviceCrashesResponse {
  device: { model: string; os: string };
  totals: { crashes: number; distinctIssues: number; usersAffected: number };
  rows: ICrashEvent[];
  nextCursor: string | null;
  meta: IHealthMeta;
}
export interface ICrashFreeByReleaseResponse {
  platform: string;
  rows: ICrashFreeRelease[];
  meta: IHealthMeta;
}

/** One line of a stack trace. */
export interface ICrashFrame {
  file: string | null;
  function: string | null;
  line: number | null;
  inApp: boolean;
}

/** The exception behind a crash, when the event carries one. */
export interface ICrashException {
  type: string | null;
  value: string | null;
  mechanism: string | null;
  frames: ICrashFrame[];
  truncated: boolean;
}

export interface ICameraReport {
  filters: IHealthFilters;
  totals: {
    issues: number;
    reportedFailures: number;
    crashes: number;
    devicesAffected: number;
  };
  meta: IHealthMeta;
}

export interface ICameraIssueDeviceRow {
  device: string;
  os: string;
  issues: number;
  usersAffected: number;
  lastIssueAt: string | null;
}

export interface ICameraIssueDevicesResponse {
  rows: ICameraIssueDeviceRow[];
  nextCursor: string | null;
  meta: IHealthMeta;
}

/** One camera issue — our own reported failure, or a camera crash. */
export interface ICameraIssue {
  eventId: string | null;
  userId: string | null;
  userName: string | null;
  at: string;
  title: string;
  kind: string;
  stage: string | null;
  code: string | null;
  culprit: string | null;
  release: string | null;
  device: string | null;
  os: string | null;
}

export interface ICameraDeviceIssuesResponse {
  device: { model: string; os: string };
  total: number;
  rows: ICameraIssue[];
  nextCursor: string | null;
  meta: IHealthMeta;
}
