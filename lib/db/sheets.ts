import * as mongoose from "mongoose";
import {
  SHEET_DEFAULT_TITLE,
  SHEET_SCHEMA_VERSION,
  SHEET_STATUS,
} from "../utils/enums/sheet";

const ObjectId = mongoose.Schema.Types.ObjectId;

export const SheetsSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "Company",
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
    schemaVersion: {
      type: Number,
      default: SHEET_SCHEMA_VERSION,
      required: true,
    },
    title: {
      type: String,
      default: SHEET_DEFAULT_TITLE,
      required: true,
    },
    projectName: {
      type: String,
    },
    projectAddress: {
      type: String,
    },
    // ProseMirror (TipTap) JSON, same shape as a daily log's overviewDoc.
    bodyDoc: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    photos: [
      {
        _id: false,
        fileId: { type: String, required: true },
        postId: { type: String },
        url: { type: String, required: true },
        quickView: { type: String },
        order: { type: Number, default: 0 },
        uploadedBy: { type: String },
        uploadedById: { type: String },
        uploadedAt: { type: String },
      },
    ],
    bodyText: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: Object.values(SHEET_STATUS),
      default: SHEET_STATUS.ACTIVE,
    },
  },
  { timestamps: true, versionKey: false },
);

SheetsSchema.index({ projectId: 1, status: 1, createdAt: -1 });
