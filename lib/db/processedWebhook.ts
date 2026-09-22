import * as mongoose from "mongoose";

export interface IProcessedWebhook {
  _id: mongoose.Types.ObjectId;
  eventId: string;
  provider: string;
  processedAt: Date;
}

export const ProcessedWebhookSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
    },
    provider: {
      type: String,
      required: true,
    },
    processedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false },
);

// Compound unique index for idempotency
ProcessedWebhookSchema.index({ eventId: 1, provider: 1 }, { unique: true });

// Auto-delete after 7 days (604800 seconds)
ProcessedWebhookSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 604800 },
);
