import * as mongoose from "mongoose";
import {
  DAILY_LOG_LANGUAGE,
  DAILY_LOG_LANGUAGES,
  DAILY_LOG_SCHEMA_VERSION,
  DAILY_LOG_STATUS,
} from "../utils/enums/dailyLog";

const ObjectId = mongoose.Schema.Types.ObjectId;

export const DailyLogsSchema = new mongoose.Schema(
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
      default: DAILY_LOG_SCHEMA_VERSION,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    projectName: {
      type: String,
    },
    projectAddress: {
      type: String,
    },
    summaryDate: {
      type: String,
      required: true,
    },
    language: {
      type: String,
      enum: DAILY_LOG_LANGUAGES,
      default: DAILY_LOG_LANGUAGE.EN,
      required: true,
    },
    contributors: [
      {
        _id: false,
        userId: { type: ObjectId, ref: "User" },
        name: { type: String, required: true },
      },
    ],
    overviewDoc: {
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
        tags: { type: [String], default: undefined },
        description: { type: String },
        uploadedBy: { type: String },
        uploadedById: { type: String },
        uploadedAt: { type: String },
      },
    ],
    todos: [
      {
        _id: false,
        text: { type: String, default: "" },
        done: { type: Boolean, default: false },
        source: { type: String, enum: ["ai", "user"] },
      },
    ],
    notesDoc: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    bodyText: {
      type: String,
      default: "",
    },
    generatedFromFileIds: { type: [String], default: undefined },
    status: {
      type: String,
      enum: Object.values(DAILY_LOG_STATUS),
      default: DAILY_LOG_STATUS.ACTIVE,
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

DailyLogsSchema.index({ projectId: 1, status: 1, createdAt: -1 });
