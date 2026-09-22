import * as mongoose from "mongoose";

export const otpSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
    },
    email: {
      type: String,
    },
    otp: {
      type: String,
    },
    isValid: {
      type: Boolean,
      default: true,
    },
    // Proof that this email/phone completed an OTP challenge. Registration
    // requires a recent `verified` record so unverified clients can't create
    // accounts by skipping the OTP flow entirely.
    verified: {
      type: Boolean,
      default: false,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

otpSchema.index({ phone: "text" });
otpSchema.index({ email: "text" });

// Exact-match lookups used by the signup verification gate — the text indexes
// above can't serve these.
otpSchema.index({ email: 1 });
otpSchema.index({ phone: 1 });
