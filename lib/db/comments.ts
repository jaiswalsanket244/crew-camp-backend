import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { STATUS } from "../utils/enums/enums";

export const CommentSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    postId: {
      type: ObjectId,
      ref: "posts",
      required: function () {
        return !this.commentId && !this.projectId && !this.projectNoteId;
      },
    },
    fileId: {
      type: ObjectId,
      ref: "postFiles",
    },
    projectId: {
      type: ObjectId,
      ref: "Project",
      required: function () {
        return !this.commentId && !this.postId && !this.projectNoteId;
      },
    },
    commentId: {
      type: ObjectId,
      ref: "Comment",
      required: function () {
        return !this.postId && !this.projectId && !this.projectNoteId;
      },
    },
    projectNoteId: {
      type: ObjectId,
      ref: "Comment",
      required: function () {
        return !this.postId && !this.projectId && !this.commentId;
      },
    },
    status: {
      type: String,
      enum: STATUS,
      default: "ACTIVE",
    },
    // Set when this row was soft-deleted as part of its project going to the
    // bin, holding the status it had beforehand. Presence means "deleted with
    // the project" (so per-entity bins hide it); the value is what a project
    // restore puts back, which matters for PENDING/COMPLETED rows.
    preDeleteStatus: {
      type: String,
      required: false,
    },
    comment: {
      type: String,
      required: false,
    },
    fileUrl: {
      type: String,
      required: false,
    },
    fileSize: {
      width: Number,
      height: Number,
    },
    mentions: [
      {
        type: ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true },
);

CommentSchema.index({ postId: 1, projectId: 1, commentId: 1 });
