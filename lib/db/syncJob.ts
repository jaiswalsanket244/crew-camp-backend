import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

// Types of sync operations
export const SYNC_JOB_TYPE = [
  "inbound_project",
  "outbound_photo",
  // A CrewCam post's note pushed to the CRM as an activity/note record.
  "outbound_activity",
] as const;
export type SyncJobType = (typeof SYNC_JOB_TYPE)[number];

// Sync job status
export const SYNC_JOB_STATUS = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUS)[number];

export interface ISyncJob {
  _id: mongoose.Types.ObjectId;
  integrationId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;
  type: SyncJobType;
  status: SyncJobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  result: {
    success: boolean;
    externalId?: string;
    errorMessage?: string;
    rawResponse?: Record<string, unknown>;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export const SyncJobSchema = new mongoose.Schema(
  {
    integrationId: {
      type: ObjectId,
      ref: "Integration",
      required: true,
    },
    projectId: {
      type: ObjectId,
      ref: "project",
      required: false,
    },
    type: {
      type: String,
      enum: SYNC_JOB_TYPE,
      required: true,
    },
    status: {
      type: String,
      enum: SYNC_JOB_STATUS,
      default: "pending",
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lastAttemptAt: { type: Date, default: null },
    nextRetryAt: { type: Date, default: null },
    result: {
      success: { type: Boolean },
      externalId: { type: String },
      errorMessage: { type: String },
      rawResponse: { type: mongoose.Schema.Types.Mixed },
    },
  },
  { timestamps: true },
);

// Index for finding jobs to process
SyncJobSchema.index({ status: 1, nextRetryAt: 1 });
SyncJobSchema.index({ integrationId: 1, status: 1 });
SyncJobSchema.index({ projectId: 1 });
