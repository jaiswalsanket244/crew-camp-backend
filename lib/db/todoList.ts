import * as mongoose from "mongoose";
import { CHECKLIST_STATUS, FIELD_TYPE } from "../utils/enums/checklist";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const TodoListSchema = new mongoose.Schema(
  {
    checklistId: {
      type: ObjectId,
      ref: "ProjectChecklist",
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: false,
    },
    questions: [
      {
        label: { type: String },
        value: { type: String },
      },
    ],
    status: {
      type: String,
      enum: CHECKLIST_STATUS,
      default: CHECKLIST_STATUS.PENDING,
    },
    taskImages: [
      {
        imageData: {
          url: { type: String },
          fileType: { type: String },
          size: {
            width: { type: Number },
            height: { type: Number },
          },
        },
      },
    ],
    postId: {
      type: ObjectId,
      ref: "Posts",
    },
    completedBy: {
      type: ObjectId,
      ref: "User",
    },
    completedAt: {
      type: Date,
    },
    sortOrder: {
      type: Number,
      default: 0,
      require: true,
    },
    areImagesMandatory: {
      type: Boolean,
      default: false,
    },
    // V2 typed fields — additive. Legacy todos simply have empty fields/responses.
    // Subdocument _id is intentionally left enabled: it is the fieldId clients reference.
    fields: [
      {
        fieldType: {
          type: String,
          enum: Object.values(FIELD_TYPE),
          required: true,
        },
        label: { type: String, required: true },
        required: { type: Boolean, default: false },
        sortOrder: { type: Number, default: 0 },
        config: { type: mongoose.Schema.Types.Mixed, default: {} },
      },
    ],
    responses: [
      {
        fieldId: { type: ObjectId, required: true }, // references fields[i]._id
        fieldType: {
          type: String,
          enum: Object.values(FIELD_TYPE),
          required: true,
        },
        value: { type: mongoose.Schema.Types.Mixed, default: null },
        updatedBy: { type: ObjectId, ref: "User" },
        updatedAt: { type: Date },
      },
    ],
  },
  { timestamps: true, versionKey: false },
);
