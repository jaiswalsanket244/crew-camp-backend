import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

// Allowed values — exported so the /reindex validator and worker switch import these instead of re-typing the literals (prevents magic-string drift).
export const SEARCH_JOB_TYPES = [
  "REINDEX_FULL",
  "REINDEX_COMPANY",
  "REINDEX_INCREMENTAL",
] as const;
export const SEARCH_JOB_INDEXES = ["projects", "posts_uploads"] as const;
export const SEARCH_JOB_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
] as const;

// Reindex job queue: the admin POST /reindex endpoint enqueues a PENDING job; the search-worker reindex loop polls status:"PENDING", atomically findOneAndUpdate-claims it to RUNNING, executes, and records progress/result — full audit trail.
export const SearchJobSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: SEARCH_JOB_TYPES,
      required: true,
    },
    index: {
      type: String,
      enum: SEARCH_JOB_INDEXES,
      required: true, // alias name being reindexed
    },
    companyId: {
      type: ObjectId,
      ref: "Company", // set for REINDEX_COMPANY jobs
    },
    since: {
      type: Date, // set for REINDEX_INCREMENTAL jobs
    },
    status: {
      type: String,
      enum: SEARCH_JOB_STATUSES,
      default: "PENDING",
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    progress: {
      documentsIndexed: { type: Number, default: 0 },
      documentsTotal: { type: Number, default: 0 },
    },
    error: { type: String },
    triggeredBy: {
      type: ObjectId,
      ref: "User",
      required: true, // admin user who triggered the reindex
    },
  },
  { timestamps: true },
);

// Worker polls status:"PENDING" and findOneAndUpdate-claims the OLDEST to RUNNING. Compound (status, createdAt) so the {status:'PENDING'} filter + sort:{createdAt:1} claim is index-backed (FIFO, no starvation); the prefix still serves status-only queries.
SearchJobSchema.index({ status: 1, createdAt: 1 });
