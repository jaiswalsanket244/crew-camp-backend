import * as mongoose from "mongoose";

export const CrewsProjectsSchema = new mongoose.Schema(
  {
    crewId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Crew",
      required: true,
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

CrewsProjectsSchema.index({ crewId: 1, projectId: 1 });
