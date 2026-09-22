import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { STATUS } from "../utils/enums/enums";

export const PostSchema = new mongoose.Schema(
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
    companyId: {
      type: ObjectId,
      ref: "Company",
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
    totalFiles: {
      type: Number,
      required: true,
    },
    externalCompanyCamPostId: {
      type: String,
      required: false,
    },
  },
  { timestamps: true },
);

PostSchema.index({ status: 1, projectId: 1, createdAt: -1 });
PostSchema.index({ companyId: 1, status: 1, createdAt: -1 });
