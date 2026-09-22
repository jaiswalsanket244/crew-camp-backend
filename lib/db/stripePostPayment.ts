import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const StripePostPaymentSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "Companies",
      required: true,
    },
    teamLimit: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);

StripePostPaymentSchema.index({ companyId: 1 });
