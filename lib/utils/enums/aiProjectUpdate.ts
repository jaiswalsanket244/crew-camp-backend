// AI Project Update — the multi-day sibling of the AI Daily Log.
// Language handling is shared with the daily log (DAILY_LOG_LANGUAGE /
// toDailyLogLanguage) so the two features can never drift on supported
// languages; only the status and limits are owned here.

export enum AI_PROJECT_UPDATE_STATUS {
  ACTIVE = "active",
  DELETED = "deleted",
}

export const AI_PROJECT_UPDATE_SCHEMA_VERSION = 1;

// Hard cap on photos per update. The frontend refuses to exceed it and the
// backend rejects with 422 — never a silent slice.
export const AI_PROJECT_UPDATE_MAX_PHOTOS = 50;

export const AI_PROJECT_UPDATE_TITLE_MAX_LENGTH = 120;

// Rich-text (ProseMirror JSON) payload ceiling for the overview.
export const AI_PROJECT_UPDATE_OVERVIEW_MAX_BYTES = 64 * 1024;

// Generate request ceiling. Sits under the 1 MB express.json limit so the
// caller gets a specific 422 rather than a generic 413.
export const AI_PROJECT_UPDATE_GENERATE_MAX_BYTES = 512 * 1024;

// Per-photo source-text caps mirror the client collector's limits so a
// hand-rolled request cannot push an oversized prompt.
export const AI_PROJECT_UPDATE_MAX_COMMENTS_PER_PHOTO = 50;
export const AI_PROJECT_UPDATE_MAX_SOURCE_CHARS = 30_000;
