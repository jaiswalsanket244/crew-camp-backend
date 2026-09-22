import * as mongoose from "mongoose";
import { STATUS } from "../utils/enums/enums";

// For Future Reference => If you want to store the stripe plans to DB
export const SubscriptionPlanSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    type: {
      type: String, // Basic, Premium
      required: true,
    },
    currency: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    description: {
      type: String,
      required: false,
    },
    image: {
      type: String,
      required: false,
    },

    productId: {
      type: String, // stripe subscription product Id
      required: false,
    },
    priceId: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: STATUS,
      required: true,
      default: "ACTIVE",
    },
  },
  { timestamps: true },
);
