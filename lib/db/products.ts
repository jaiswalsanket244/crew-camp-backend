import * as mongoose from "mongoose";
import { STATUS } from "../utils/enums/enums";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const ProductSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    productImages: {
      type: [String],
      required: false,
    },
    description: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: false,
    },
    costPrice: {
      type: Number,
      required: false,
    },
    retailPrice: {
      type: Number,
      required: false,
    },
    salePrice: {
      type: Number,
      required: false,
    },
    createdBy: {
      type: ObjectId,
      required: true,
      ref: "User",
    },
    status: {
      type: String,
      enum: STATUS,
      default: "ACTIVE",
    },
  },
  { timestamps: true },
);

ProductSchema.index({ name: "text" });
