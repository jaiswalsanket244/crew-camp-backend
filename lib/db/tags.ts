import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { CURRENT_TAGS, TAGS, TAGS_FOR } from "../utils/enums/enums";

export const TagsSchema = new mongoose.Schema(
  {
    tag: {
      type: String,
      required: true,
    },
    color: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: TAGS,
      default: CURRENT_TAGS.CUSTOM,
    },
    companyId: {
      type: ObjectId,
      ref: "company",
      required: false,
    },
    tagFor: {
      type: String,
      enum: TAGS_FOR,
      default: TAGS_FOR.PROJECT,
    },
  },
  { timestamps: true },
);

TagsSchema.index({ companyId: 1, type: 1 });
