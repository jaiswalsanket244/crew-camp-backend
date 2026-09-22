import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { STATUS } from "../utils/enums/enums";

export const ProjectNotesSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    projectId: {
      type: ObjectId,
      ref: "Project",
      required: true,
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
    note: {
      type: String,
      required: false,
    },
    files: [
      {
        url: { type: String },
        size: {
          width: Number,
          height: Number,
        },
      },
    ],
  },
  { timestamps: true },
);

ProjectNotesSchema.index({ postId: 1, projectId: 1, commentId: 1 });
// Serves the project notes list and the tab-count query, both of which filter
// by { projectId, status }. The compound index above leads with postId and
// cannot serve those queries.
ProjectNotesSchema.index({ projectId: 1, status: 1 });
