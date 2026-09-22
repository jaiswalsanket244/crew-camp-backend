import * as StandardError from "standard-error";
import validator from "validator";
import * as status from "http-status";
import { Otp, User } from "../../db";
import SocialAuth from "../../services/socialAuth";
import { OtpSignupIdentifiers, OtpTarget } from "../../utils/interfaces/otp";
import { SIGNUP_VERIFICATION_WINDOW_MINUTES } from "../../utils/constants/constants";

export class AuthHelpers {
  public static validatePhoneRegistration = (phone: number) => {
    if (!validator.isMobilePhone(phone)) {
      throw new StandardError({
        message: "Invalid Phone Number!",
        code: status.UNPROCESSABLE_ENTITY,
      });
    }
  };

  public static async verifySocialLoginRegister(payload: {
    oauth: string;
    accessToken: string;
    email: string;
    idToken: string;
  }) {
    const socialAuth = new SocialAuth(payload.accessToken);

    switch (payload.oauth) {
      case "GOOGLE":
        return socialAuth.google();
      case "FACEBOOK":
        return socialAuth.facebook();
      case "MICROSOFT":
        return socialAuth.microsoft();
      case "APPLE":
        return socialAuth.apple(payload.email, payload.idToken);
      case "PHONE":
        return socialAuth.google();
      default:
        break;
    }

    return true;
  }

  // Increase the referral Rewards for the referrer and the user when a new user signs up
  public static giveReferralRewards = async (
    userId: string,
    points: number,
  ) => {
    try {
      return User.findByIdAndUpdate(
        { _id: userId },
        { $inc: { referralRewards: points } },
      );
    } catch (error) {
      console.error(error);
    }
  };

  public static updateOtp = (email: string, otp: string) => {
    // Clears any prior verification alongside the new code, matching
    // request-otp — this collection is shared with the signup gate.
    return Otp.updateOne(
      { email },
      { $set: { otp, verified: false, verifiedAt: null } },
      { upsert: true },
    );
  };

  public static findOneOtp = (otpQuery: any) => {
    return Otp.findOne(otpQuery);
  };

  /**
   * Marks an email/phone as having completed an OTP challenge.
   *
   * The OTP code itself is unset so the same code can't be replayed, while the
   * `verified` marker survives for `SIGNUP_VERIFICATION_WINDOW_MINUTES` as the
   * proof that registration checks.
   */
  public static markOtpVerified = (target: OtpTarget) => {
    return Otp.updateOne(
      target,
      {
        $set: { verified: true, verifiedAt: new Date() },
        $unset: { otp: 1 },
      },
      { upsert: true },
    );
  };

  /**
   * True when the email or the phone on a signup request completed an OTP
   * challenge recently. Either channel counts: the clients verify one of the
   * two, not both.
   */
  public static hasRecentOtpVerification = async (
    identifiers: OtpSignupIdentifiers,
  ): Promise<boolean> => {
    const targets: OtpTarget[] = [];
    if (identifiers.email) targets.push({ email: identifiers.email });
    if (identifiers.phone) targets.push({ phone: identifiers.phone });

    if (!targets.length) return false;

    const verifiedAfter = new Date(
      Date.now() - SIGNUP_VERIFICATION_WINDOW_MINUTES * 60 * 1000,
    );

    const verification = await Otp.findOne({
      $or: targets,
      verified: true,
      verifiedAt: { $gte: verifiedAfter },
    });

    return !!verification;
  };

  // Clears the verification proof once it has been spent on a registration so
  // a single OTP can't seed multiple accounts.
  public static consumeOtpVerification = (
    identifiers: OtpSignupIdentifiers,
  ) => {
    const targets: OtpTarget[] = [];
    if (identifiers.email) targets.push({ email: identifiers.email });
    if (identifiers.phone) targets.push({ phone: identifiers.phone });

    if (!targets.length) return;

    return Otp.deleteMany({ $or: targets });
  };
}
