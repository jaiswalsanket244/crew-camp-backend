import * as mongoose from "mongoose";
import {
  PHOTOS_PER_PAGE,
  REPORT_STATUS,
  REPORT_SOURCE,
} from "../utils/enums/projectReports";

const ObjectId = mongoose.Schema.Types.ObjectId;

export const ProjectReportsSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "projects",
      required: true,
    },
    projectId: {
      type: ObjectId,
      ref: "projects",
      required: true,
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    reportName: {
      type: String,
      required: true,
    },
    photosPerPage: {
      type: Number,
      default: PHOTOS_PER_PAGE.DEFAULT,
      required: true,
    },
    showCoverPage: {
      type: Boolean,
      default: false,
    },
    showCoverPageImage: {
      type: Boolean,
      default: false,
    },
    coverPageImage: {
      type: String,
    },
    showCompanyName: {
      type: Boolean,
      default: false,
    },
    showCompanyLogo: {
      type: Boolean,
      default: false,
    },
    showCreatedBy: {
      type: Boolean,
      default: false,
    },
    showCreatedAt: {
      type: Boolean,
      default: false,
    },
    showPageCount: {
      type: Boolean,
      default: false,
    },
    reportSource: {
      type: String,
      enum: [REPORT_SOURCE.AI, REPORT_SOURCE.MANUAL],
      default: REPORT_SOURCE.MANUAL,
    },
    status: {
      type: String,
      default: REPORT_STATUS.ACTIVE,
      enum: REPORT_STATUS,
    },
    // Set when this row was soft-deleted as part of its project going to the
    // bin, holding the status it had beforehand. Presence means "deleted with
    // the project" (so per-entity bins hide it); the value is what a project
    // restore puts back, which matters for PENDING/COMPLETED rows.
    preDeleteStatus: {
      type: String,
      required: false,
    },
  },
  { timestamps: true, versionKey: false },
);

// Serves every read here, including the cross-project lists (/list/all and
// /mine), which both lead with `projectId: { $in: <my projects> }`.
ProjectReportsSchema.index({ projectId: 1 });
