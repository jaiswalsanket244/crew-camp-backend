import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { MEMBER_TYPE, STATUS } from "../utils/enums/enums";

export const ProjectMemberSchema = new mongoose.Schema(
  {
    projectId: {
      type: ObjectId,
      ref: "Project",
      required: true,
    },
    userId: {
      type: ObjectId,
      ref: "User",
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
    type: {
      type: String,
      enum: MEMBER_TYPE,
      required: false,
    },
  },
  { timestamps: true },
);

ProjectMemberSchema.index({ projectId: 1, userId: 1 });
