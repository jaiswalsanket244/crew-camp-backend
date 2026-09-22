import * as mongoose from "mongoose";
import { REFUND_STATUS } from "../utils/enums/enums";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const RefundsSchema = new mongoose.Schema(
  {
    refundedAmount: {
      type: Number,
      default: 0,
      required: true,
    },
    orderRef: {
      type: ObjectId,
      required: true,
      ref: "Orders",
      unique: true,
    },
    status: {
      type: String,
      enum: REFUND_STATUS,
      default: "PENDING",
      required: true,
    },
    reason: {
      type: String,
      default: "requested_by_customer",
      required: true,
    },
  },
  { timestamps: true },
);
RefundsSchema.index({ chargeId: "text", refundId: "text", paymentId: "text" });
