import * as mongoose from "mongoose";
import { IFileSchema } from "../utils/interfaces/files";
import { FileAccessType } from "../utils/enums/files";
import { CURRENT_STATUS } from "../utils/enums/enums";

const ObjectId = mongoose.Schema.Types.ObjectId;

export const FilesKeySchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "Companies",
      required: true,
      index: true,
    },
    projectId: {
      type: ObjectId,
      ref: "Projects",
      required: true,
      index: true,
    },
    userId: {
      type: ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    fileType: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    accessLevel: {
      type: String,
      enum: FileAccessType,
      default: FileAccessType.PUBLIC,
      required: true,
    },
    status: {
      type: String,
      enum: CURRENT_STATUS,
      default: CURRENT_STATUS.ACTIVE,
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
  {
    timestamps: true,
    versionKey: false,
    toObject: {
      virtuals: true,
    },
    toJSON: {
      virtuals: true,
    },
  },
);

FilesKeySchema.index({ projectId: 1 });

export const Files = mongoose.model<IFileSchema>("Files", FilesKeySchema);
