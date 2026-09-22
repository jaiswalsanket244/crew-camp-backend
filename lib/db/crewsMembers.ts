import * as mongoose from "mongoose";
import { STATUS } from "../utils/enums/enums";

export const CrewsMembersSchema = new mongoose.Schema(
  {
    crewId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Crew",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: STATUS,
      default: "ACTIVE",
    },
  },
  {
    timestamps: true,
  },
);

CrewsMembersSchema.index({ crewId: 1, userId: 1 });
