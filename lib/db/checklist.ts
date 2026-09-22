import * as mongoose from "mongoose";
import { CHECKLIST_STATUS, CHECKLIST_TYPE } from "../utils/enums/checklist";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const ChecklistSchema = new mongoose.Schema(
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
    name: {
      type: String,
      required: true,
    },
    contributors: {
      type: [ObjectId],
      ref: "User",
    },
    status: {
      type: String,
      enum: CHECKLIST_STATUS,
      default: CHECKLIST_STATUS.PENDING,
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
      enum: Object.values(CHECKLIST_TYPE),
      default: CHECKLIST_TYPE.CHECKLIST,
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);

ChecklistSchema.index({ projectId: 1 });
// Backs the company-wide list (GET /checklist with no projectId), which
// otherwise scans the whole collection across every tenant — the only index
// here used to be { projectId: 1 }. Key order follows ESR: companyId + type are
// equality, createdAt is the sort, and `status: { $ne: DELETED }` is a range so
// it stays out. The onlyMine=true variant rides the same prefix and filters
// userId / contributors on the fetched docs.
ChecklistSchema.index({ companyId: 1, type: 1, createdAt: -1 });
