import * as mongoose from "mongoose";
import { STATUS } from "../utils/enums/enums";

export const CrewsSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: STATUS,
      default: "ACTIVE",
    },
    companyId: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);
