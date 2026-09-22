import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { SORT_TYPE } from "../utils/enums/post";

export const UserSettingsSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    homePageView: {
      sortBy: {
        type: String,
        enum: SORT_TYPE,
        default: SORT_TYPE.NEWEST,
      },
    },
  },
  { timestamps: true, versionKey: false },
);

UserSettingsSchema.index({ userId: 1 });
