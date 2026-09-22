import { Request } from "express";
import { OtpSignupIdentifiers } from "../interfaces/otp";

// Log prefix — grep this to count signups that skipped the OTP flow.
const LOG_TAG = "[signup-verification]";

/**
 * Records a signup that carried no recent OTP verification. Captures the
 * request fingerprint so bot traffic can be told apart from a legitimate
 * client flow that skips verify-otp.
 */
export const logUnverifiedSignup = (
  req: Request,
  identifiers: OtpSignupIdentifiers,
): void => {
  console.warn(LOG_TAG, "unverified signup allowed (log-only mode)", {
    email: identifiers.email ?? null,
    phone: identifiers.phone ?? null,
    ip: req.ip ?? null,
    forwardedFor: req.headers["x-forwarded-for"] ?? null,
    origin: req.headers.origin ?? null,
    userAgent: req.headers["user-agent"] ?? null,
    timestamp: new Date().toISOString(),
  });
};
