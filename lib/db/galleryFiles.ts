import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const GalleryFilesSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
    },
    postId: {
      type: ObjectId,
      ref: "posts",
    },
    files: [
      {
        url: { type: String },
        fileType: { type: String },
        uploadedAt: { type: Date },
        location: {
          long: Number,
          lat: Number,
        },
      },
    ],
    galleryId: {
      type: ObjectId,
      ref: "galleryFiles",
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);
