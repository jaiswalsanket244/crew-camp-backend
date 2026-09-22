import * as mongoose from "mongoose";
import {
  DAILY_LOG_LANGUAGE,
  DAILY_LOG_LANGUAGES,
} from "../utils/enums/dailyLog";
import {
  AI_PROJECT_UPDATE_SCHEMA_VERSION,
  AI_PROJECT_UPDATE_STATUS,
} from "../utils/enums/aiProjectUpdate";

const ObjectId = mongoose.Schema.Types.ObjectId;

// Sibling of DailyLogsSchema. Differences: a date RANGE (startDate/endDate +
// the timeZone the day keys were computed in) instead of summaryDate; no
// contributors, todos or notes; per-photo `note`/`tags` kept as regenerate
// evidence; and a `generation` provenance block instead of generatedFromFileIds.
const GenerationSchema = new mongoose.Schema(
  {
    generatedAt: { type: Date, required: true },
    fileIds: { type: [String], default: [] },
    language: {
      type: String,
      enum: DAILY_LOG_LANGUAGES,
      default: DAILY_LOG_LANGUAGE.EN,
    },
    photoCount: { type: Number, default: 0 },
    descriptionCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { _id: false },
);

export const AiProjectUpdatesSchema = new mongoose.Schema(
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
      default: AI_PROJECT_UPDATE_SCHEMA_VERSION,
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
    // YYYY-MM-DD, derived by the client from the earliest/latest photo in
    // `timeZone`. Strings, like summaryDate on daily logs — these are calendar
    // days, not instants.
    startDate: {
      type: String,
      required: true,
    },
    endDate: {
      type: String,
      required: true,
    },
    timeZone: {
      type: String,
      required: true,
    },
    language: {
      type: String,
      enum: DAILY_LOG_LANGUAGES,
      default: DAILY_LOG_LANGUAGE.EN,
      required: true,
    },
    overviewDoc: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Persisted so "confirm before overwriting your edits" still works after
    // the document is reopened.
    titleEdited: { type: Boolean, default: false },
    overviewEdited: { type: Boolean, default: false },
    photos: [
      {
        _id: false,
        fileId: { type: String, required: true },
        postId: { type: String, required: true },
        url: { type: String, required: true },
        quickView: { type: String },
        order: { type: Number, default: 0 },
        uploadedBy: { type: String },
        uploadedById: { type: String },
        uploadedAt: { type: String, required: true },
        note: { type: String },
        tags: { type: [String], default: undefined },
      },
    ],
    generation: {
      type: GenerationSchema,
      default: null,
    },
    // Flattened copy of the rich-text body, kept only so the Documents
    // search can match words inside a document and not just its title.
    bodyText: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: Object.values(AI_PROJECT_UPDATE_STATUS),
      default: AI_PROJECT_UPDATE_STATUS.ACTIVE,
    },
  },
  { timestamps: true, versionKey: false },
);

// The list is always scoped by company + project and sorted by last edit.
AiProjectUpdatesSchema.index({
  companyId: 1,
  projectId: 1,
  status: 1,
  updatedAt: -1,
});
