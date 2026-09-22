import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { STATUS } from "../utils/enums/enums";

export const CompanySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      mockName: "name",
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: false,
    },
    companyLogo: {
      type: String,
      required: false,
      default: "",
    },
    status: {
      type: String,
      enum: STATUS,
      default: "ACTIVE",
    },
    teamLimit: {
      type: Number,
      required: false,
    },
    showDefaultTags: {
      type: Boolean,
      default: true,
      required: false,
    },
  },
  { timestamps: true, versionKey: false },
);

CompanySchema.index({ userId: 1 });
