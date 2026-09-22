import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const ReferralsSchema = new mongoose.Schema(
  {
    referredByRef: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    referredToRef: {
      type: ObjectId,
      ref: "User",
    },
    dateOfJoining: {
      type: Date,
    },
    points: {
      type: Number,
      required: true,
      default: 0,
    },
    type: {
      type: String,
      enum: ["SIGN_UP"],
      required: false,
    },
    referralActive: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);
