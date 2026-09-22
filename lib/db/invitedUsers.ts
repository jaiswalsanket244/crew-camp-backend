import * as mongoose from "mongoose";
import { INVITED_USER_STATUS, USER_TYPE } from "../utils/enums/enums";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const InvitedUserSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: false,
    },
    projectId: {
      type: ObjectId,
      ref: "projects",
      required: false,
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: INVITED_USER_STATUS,
      default: "PENDING",
    },
    role: {
      type: String,
      enum: USER_TYPE,
      default: "STANDARD",
    },
  },
  { timestamps: true },
);
