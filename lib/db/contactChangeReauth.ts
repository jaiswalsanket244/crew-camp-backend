import * as mongoose from "mongoose";
import { CONTACT_CHANGE_TYPE } from "../utils/enums/contactChange";

const ObjectId = mongoose.Schema.Types.ObjectId;

export const ContactChangeReauthSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    // Which current contact the user chose to verify with.
    channel: {
      type: String,
      enum: Object.values(CONTACT_CHANGE_TYPE),
      required: true,
    },
    otp: {
      type: String,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    verifiedAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

// TTL index: Mongo removes the doc once expiresAt passes (pending or grant).
ContactChangeReauthSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
