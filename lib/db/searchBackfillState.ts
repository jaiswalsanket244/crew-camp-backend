import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

// Restart-safety checkpoint for the search backfill scripts: one row per (companyId, index); a killed backfill resumes from lastProcessedProjectId (projects iterated by _id ASC), and idempotent ES _id makes a reprocessed boundary batch harmless.
export const SearchBackfillStateSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: true,
    },
    index: {
      type: String,
      required: true,
    },
    lastProcessedProjectId: {
      type: ObjectId,
    },
    // Cursor for the posts_uploads backfill, paging PostFiles by _id.
    lastProcessedFileId: {
      type: ObjectId,
    },
    batchesCompleted: {
      type: Number,
      default: 0,
    },
    startedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

SearchBackfillStateSchema.index({ companyId: 1, index: 1 });
