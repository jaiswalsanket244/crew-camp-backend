import * as mongoose from "mongoose";

export const ErrorLogsSchema = new mongoose.Schema(
  {
    errorType: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    stack: {
      type: String,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
    occurredAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

ErrorLogsSchema.index({ errorType: 1, occurredAt: -1 });

const TTL_DAYS = 60;
ErrorLogsSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 },
);
