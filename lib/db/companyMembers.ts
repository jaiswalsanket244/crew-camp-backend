import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { COMPANY_MEMBER_STATUS, USER_TYPE } from "../utils/enums/enums";

export const CompanyMemberSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "company",
      required: true,
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: COMPANY_MEMBER_STATUS,
      default: "ACTIVE",
    },
    role: {
      type: String,
      enum: USER_TYPE,
      default: "STANDARD",
    },
    deactivatedAt: {
      type: Date,
      required: false,
    },
    deactivatedBy: {
      type: ObjectId,
      ref: "User",
      required: false,
    },
  },
  { timestamps: true },
);

CompanyMemberSchema.index({ companyId: 1, userId: 1 });
