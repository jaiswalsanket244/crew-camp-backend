// A single OTP record is keyed by exactly one channel — email or phone.
export type OtpTarget = { email: string } | { phone: string };

// The channels present on a signup request; either one may carry the
// verification proof that registration requires.
export interface OtpSignupIdentifiers {
  email?: string;
  phone?: string;
}
