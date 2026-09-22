import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const ProjectReportsSectionSchema = new mongoose.Schema(
  {
    reportId: {
      type: ObjectId,
      ref: "projectReport",
      required: true,
    },
    sectionName: {
      type: String,
      required: true,
    },
    sectionDescription: {
      type: String,
      required: false,
    },
    order: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);

ProjectReportsSectionSchema.index({ reportId: 1 });
