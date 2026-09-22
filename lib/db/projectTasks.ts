import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { CURRENT_TASK_STATUS, TASK_STATUS } from "../utils/enums/enums";

export const ProjectTaskSchema = new mongoose.Schema(
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
      enum: TASK_STATUS,
      default: CURRENT_TASK_STATUS.PENDING,
    },
    // Set when this row was soft-deleted as part of its project going to the
    // bin, holding the status it had beforehand. Presence means "deleted with
    // the project" (so per-entity bins hide it); the value is what a project
    // restore puts back, which matters for PENDING/COMPLETED rows.
    preDeleteStatus: {
      type: String,
      required: false,
    },
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    severity: {
      type: String,
      required: true,
    },
    assignedTo: [
      {
        userId: {
          type: ObjectId,
          ref: "User",
          required: false,
        },
        userName: {
          type: String,
          required: false,
        },
      },
    ],
    taskImage: {
      type: String,
      required: false,
    },
  },
  { timestamps: true },
);

// Also backs GET /projectTasks/mine, whose $match leads with
// `projectId: { $in: <my projects> }`; ownership (userId / assignedTo.userId)
// is filtered on the fetched docs. Ownership-first indexes were considered and
// dropped: they only move that filter into the index, and cannot serve the
// { createdAt, _id } sort without carrying both keys. Add one only if a slow
// query log shows the fetch-and-discard cost is real.
ProjectTaskSchema.index({ projectId: 1 });
