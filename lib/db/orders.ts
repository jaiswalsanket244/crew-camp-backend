import * as mongoose from "mongoose";
import { PAYMENT_STATUS, STATUS } from "../utils/enums/enums";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const OrdersSchema = new mongoose.Schema(
  {
    productId: {
      type: ObjectId,
      required: false,
      ref: "Products",
    },
    chargeId: {
      type: String,
      required: true,
      unique: true,
    },
    userId: {
      type: ObjectId,
      required: false,
      ref: "User",
    },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUS,
      default: "PENDING",
      require: true,
    },
    status: {
      type: String,
      enum: STATUS,
      default: "ACTIVE",
    },
    paymentMethodDetails: {},
  },
  { timestamps: true },
);
