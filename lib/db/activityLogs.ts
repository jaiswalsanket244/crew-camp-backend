import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const ActivityLogsSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    month: {
        type: Number,
        required: true,
    },
    year: {
        type: Number,
        required: true,
    },
  },
  { timestamps: true },
);

ActivityLogsSchema.index({ userId: 1, month: 1, year: 1});
