import * as mongoose from "mongoose";
import { CONTACT_CHANGE_TYPE } from "../utils/enums/contactChange";

const ObjectId = mongoose.Schema.Types.ObjectId;

// OTPs for self-serve contact changes. Kept separate from the login `otp`
// collection so the public verify-otp/login flow can never consume a
// change-of-contact code (and vice versa). Verification always requires the
// authenticated userId, so a code is only usable by the account that requested it.
export const ContactChangeOtpSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(CONTACT_CHANGE_TYPE),
      required: true,
    },
    newValue: {
      type: String,
      required: true,
    },
    otp: {
      type: String,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

// TTL index: Mongo removes the document once expiresAt passes.
ContactChangeOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Exactly one pending change per (user, type). Unique so the atomic
// upsert-claim in requestContactChange can't be raced into duplicate sends
// (a concurrent second claim fails with E11000, mapped to the resend cooldown).
ContactChangeOtpSchema.index({ userId: 1, type: 1 }, { unique: true });
