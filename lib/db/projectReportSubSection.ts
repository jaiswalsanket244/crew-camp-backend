import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const ProjectReportsSubSectionSchema = new mongoose.Schema(
  {
    sectionId: {
      type: ObjectId,
      ref: "projectReportSection",
      required: true,
    },
    subSectionName: {
      type: String,
      required: false,
    },
    image: {
      type: String,
      required: false,
    },
    description: {
      type: String,
      required: false,
    },
    order: {
      type: Number,
      required: true,
    },
    uploadData: {
      uploadedAt: {
        type: String,
        required: false,
      },
      uploadedBy: {
        type: String,
        required: false,
      },
    },
    userId: {
      type: ObjectId,
      ref: "users",
      required: false,
    },
  },
  { timestamps: true, versionKey: false },
);

ProjectReportsSubSectionSchema.index({ sectionId: 1 });
