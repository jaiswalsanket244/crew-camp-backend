import * as mongoose from "mongoose";
import {
  NotificationCategory,
  NotificationMessageKey,
} from "../utils/enums/enums";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const NotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    // Pre-rendered English copy. Kept as the source of truth for rows without
    // a messageKey (free-form report bodies, legacy rows) and as the fallback
    // for clients that read `message` directly.
    message: {
      type: String,
      required: true,
    },
    // Locale-independent template + its data. When present, the read path
    // renders `message` from these in the reader's language.
    messageKey: {
      type: String,
      enum: Object.values(NotificationMessageKey),
      required: false,
    },
    messageParams: {
      type: mongoose.Schema.Types.Mixed,
      required: false,
    },
    isOpened: {
      type: Boolean,
      default: false,
    },
    category: {
      type: String,
      enum: Object.values(NotificationCategory),
      default: NotificationCategory.OTHER,
    },
    createdBy: {
      type: ObjectId,
      required: false,
    },
    url: {
      type: String,
      required: false,
    },
    postId: {
      type: ObjectId,
      ref: "posts",
      required: false,
    },
    projectId: {
      type: ObjectId,
      ref: "projects",
      required: false,
    },
    taskId: {
      type: ObjectId,
      ref: "tasks",
      required: false,
    },
  },
  { timestamps: true },
);
