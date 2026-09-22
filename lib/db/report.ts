import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const ReportsSchema = new mongoose.Schema(
  {
    postId: {
      type: ObjectId,
      ref: "posts",
      required: true,
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    reason: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: false,
    },
    isOpened: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    creatorName:{
      type: String,
      required: true,
    }
  },
  { timestamps: true },
);

ReportsSchema.index({userId:1, commentId:1, noteId: 1});

