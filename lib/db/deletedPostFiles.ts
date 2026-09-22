import * as mongoose from "mongoose";
import { CURRENT_STATUS } from "../utils/enums/enums";

const ObjectId = mongoose.Schema.Types.ObjectId;

export const DeletedPostFilesSchema = new mongoose.Schema(
  {
    postId: {
      type: ObjectId,
      ref: "post",
      required: true,
      index: true,
    },
    projectId: {
      type: ObjectId,
      ref: "project",
      required: true,
      index: true,
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    fileId: {
      type: ObjectId,
      required: true,
      index: true,
    },
    // Store the complete file data
    fileData: {
      url: { type: String, required: true },
      fileType: { type: String },
      uploadedAt: { type: Date },
      size: {
        width: Number,
        height: Number,
      },
      location: {
        long: Number,
        lat: Number,
      },
      tags: [
        {
          type: ObjectId,
          ref: "tags",
        },
      ],
      note: { type: String },
      quickView: { type: String },
      thumbnail: { type: String },
      timestamp: { type: Date },
      annotated_by: { type: String },
      // Preserve non-destructive edit data across delete/restore round-trips.
      originalUri: { type: String },
      originalFileUrl: { type: String },
      editDocument: { type: mongoose.Schema.Types.Mixed },
    },
    status: {
      type: String,
      enum: CURRENT_STATUS,
      default: CURRENT_STATUS.DELETED,
    },
    deletedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

DeletedPostFilesSchema.index({ projectId: 1, status: 1 });
DeletedPostFilesSchema.index({ postId: 1, fileId: 1 });
