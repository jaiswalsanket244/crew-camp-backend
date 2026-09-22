import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const LikesSchema = new mongoose.Schema(
  {
    commentId: {
        type: ObjectId,
        ref: "comments",
        required: function () {
          return !this.noteId;
        },
    },
    noteId: {
      type: ObjectId,
      ref: "projectnotes",
      required: function () {
        return !this.commentId;
      },
    },
    userId: {
        type: ObjectId,
        ref: "User",
        required: true,
    },
    isLiked: {
        type: Boolean,
        default: false,
        required: true,
    },
  },
  { timestamps: true },
);

LikesSchema.index({userId:1, commentId:1, noteId: 1});

