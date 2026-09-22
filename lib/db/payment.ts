import * as mongoose from "mongoose";
import { PRODUCT_TYPE } from "../utils/enums/enums";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const PaymentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: PRODUCT_TYPE,
    },
    email: {
      type: String,
      required: true,
    },
    cardToken: {
      type: String,
      required: false,
    },
    chargeId: {
      type: String,
      required: function (): boolean {
        return this.type !== "SUBSCRIPTION";
      },
    },
    amount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
    },
    stripeCustomerId: {
      type: String,
    },
    transactionId: {
      type: String,
    },

    user: {
      type: ObjectId,
      ref: "User",
      index: true,
    },
    currency: {
      type: String,
      required: true,
    },

    failureCode: {
      type: String,
    },
    failureMessage: {
      type: String,
    },
    gateWay: {
      type: String,
      required: true,
    },
    subscriptionId: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: true,
    toObject: {
      virtuals: true,
    },
    toJSON: {
      virtuals: true,
    },
  },
);

PaymentSchema.index({
  email: "text",
  chargeId: "text",
  transactionId: "text",
  cardToken: "text",
});
