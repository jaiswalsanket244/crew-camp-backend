import * as mongoose from "mongoose";

// Durable change-stream resume tokens: one row per consumer (e.g. "projects.changeStream"); the consumer persists its token before ACKing a batch so a restart resumes from the last acknowledged event.
export const SearchResumeTokenSchema = new mongoose.Schema(
  {
    consumerKey: { type: String, required: true },
    resumeToken: { type: mongoose.Schema.Types.Mixed }, // opaque BSON token blob
    updatedAt: { type: Date },
  },
  { timestamps: true },
);

SearchResumeTokenSchema.index({ consumerKey: 1 }, { unique: true });
