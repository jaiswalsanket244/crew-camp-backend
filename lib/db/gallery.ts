import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const GallerySchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);
