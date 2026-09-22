import * as mongoose from "mongoose";
import { STATUS } from "../utils/enums/enums";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const SubscriptionSchema = new mongoose.Schema(
  {
    userRef: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    planId: {
      type: String, // stripe susbscription plan id
      required: false,
    },
    planName: {
      type: String,
      required: false,
    },
    price: {
      type: Number, // stripe susbscription price
      required: true,
    },
    currentPeriodStarts: {
      type: Number,
      required: true,
    },
    currentPeriodEnds: {
      type: Number,
      required: true,
    },
    stripeSubscriptionId: {
      type: String, // stripe susbscription purchase id
      required: false,
    },
    subscriptionCancellationRequested: {
      type: Boolean,
      default: false,
    },
    stripeCustomerId: {
      type: String,
    },
    productId: {
      type: String,
      required: false,
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
