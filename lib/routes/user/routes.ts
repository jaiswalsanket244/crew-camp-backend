import * as express from "express";
import * as status from "http-status";
import { randomInt } from "crypto";
import { firebaseService } from "../../services/firebaseAdmin";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { Validator } from "node-input-validator";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { config } from "../../utils/configuration/config";
import {
  getJWTToken,
  getMonthAndYear,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import { User } from "../../db";
import { NotificationsHelpers } from "../notifications/helpers";
import { ProjectHelper } from "../projects/helper";
import {
  NotificationMessageKey,
  SUBSCRIPTION_STATUS,
  SUPPORTED_LANGUAGES,
  USER_ROLE,
} from "../../utils/enums/enums";
import { UserHelper } from "./helper";
import { CompanyHelpers } from "../company/helpers";
import { EmailService } from "../../services/email";
import { AuthHelpers } from "../auth/helpers";
import { RevenueCatService } from "../../services/revenueCatService";
import {
  CONTACT_US_URL,
  subscriptionPlanUsers,
} from "../../utils/constants/constants";
import { stripeService } from "../../services/stripeService";
import { isAdminUser } from "../../utils/helpers/users";
import { canEditMemberInfo } from "../../utils/helpers/memberAccess";
import { TwilioMessageService } from "../../services/twilio";
import { SalesForceService } from "../../services/salesforce";
import { addUserToGetStreamClient } from "../../services/getStream";
import { CONTACT_CHANGE_TYPE } from "../../utils/enums/contactChange";
export class UserRoutes {
  static JWT_SECRET: string = config.JWT_SECRET || "i am a tea pot";

  static readonly CONTACT_OTP_EXPIRY_MINUTES = 10;
  static readonly CONTACT_OTP_MAX_ATTEMPTS = 5;
  static readonly CONTACT_OTP_RESEND_COOLDOWN_MS = 60 * 1000;
  static readonly CONTACT_PHONE_TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
  static readonly REAUTH_GRANT_TTL_MS = 10 * 60 * 1000;

  public static me = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      if (!req.user) {
        return ErrorResponse(res, status.UNAUTHORIZED, { message: "Error." });
      } else {
        const projects = await ProjectHelper.getMyProjects(req.user._id);

        await UserHelper.lastActive(req.user._id);

        const admin = await CompanyHelpers.getCompanyAdminId(
          req?.user?.companies?.[0]?.companyId,
        );
        let subscriptionStatus: any = {
          subscriptionStatus: SUBSCRIPTION_STATUS.NO_SUBSCRIPTION,
        };
        let maxTeamSize;

        if (admin?.userId) {
          const adminUser = await UserHelper.findOne({ _id: admin.userId });
          const [revenueCat, stripe] = await Promise.all([
            RevenueCatService.getSubScriptionStatus(admin?.userId, true, true),
            stripeService.getSubscriptionStatus(adminUser?.stripeCustomerId),
          ]);

          if (stripe?.subscriptionStatus) {
            subscriptionStatus = stripe;
            maxTeamSize = admin.teamLimit;
          } else subscriptionStatus = revenueCat;
        }

        let companyMembersLimitExceded = false;

        const companyMembers = await CompanyHelpers.getCompanyMembers([
          req.user.companyId,
        ]);

        maxTeamSize =
          maxTeamSize ||
          subscriptionPlanUsers(
            subscriptionStatus?.subscriptionPlan?.split(/[_-]/)?.[0],
          );

        if (maxTeamSize < companyMembers.length) {
          companyMembersLimitExceded = true;
        }

        if (
          !isAdminUser(req.user.roles) &&
          companyMembersLimitExceded &&
          subscriptionStatus.subscriptionStatus ===
            SUBSCRIPTION_STATUS.NO_SUBSCRIPTION
        ) {
          subscriptionStatus.subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
        }
        const { year, month } = getMonthAndYear(new Date());

        const [userSettings] = await Promise.all([
          UserHelper.getUserSettings(req.user._id),
          UserHelper.updateActivitylogs(req.user._id, month, year),
          UserHelper.findByIdAndUpdate(admin?.userId, subscriptionStatus),
        ]);

        return SuccessResponse(res, status.OK, {
          message: "Success.",
          data: {
            ...req.user,
            myTotalProjects: projects.length,
            roles: req?.user?.companies?.[0]?.role,
            subscriptionStatus: subscriptionStatus.subscriptionStatus,
            subscription: subscriptionStatus,
            companyMembersLimitExceded,
            bucketName: config.S3_BUCKET_NAME,
            cdnUrl: config.CDN_URL,
            ...userSettings,
          },
        });
      }
    } catch (error) {
      next(error);
    }
  };

  public static updateProfile = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const update =
        typeof req.body.update === "string"
          ? JSON.parse(req.body.update)
          : req.body.update;

      delete update.email;
      delete update.phone;

      const companyId = req.user.companyId;

      // Access files using req.files
      const files = req.files as Express.Multer.File[];
      const updatedUser: any = await User.findByIdAndUpdate(
        req.user._id,
        { $set: update },
        {
          new: true,
        },
      );

      if (files && files.length > 0) {
        const imagesPaths = [];
        const profileImagePaths = [];

        for (const file of files) {
          const { fieldname, originalname } = file;
          if (fieldname.startsWith("images")) {
            imagesPaths.push(originalname);
          } else if (fieldname.startsWith("profileImage")) {
            profileImagePaths.push(originalname);
          }
        }

        if (imagesPaths.length > 0) {
          updatedUser.images = imagesPaths;
        }

        if (profileImagePaths.length > 0) {
          updatedUser.profileImage = profileImagePaths;
        }

        // For Future Reference :--> Upload files to S3
        // try {
        //   await fileService.uploadMultipleFilesToS3(
        //     files.map((file) => ({
        //       name: file.originalname,
        //       data: file.buffer,
        //     })),
        //   );
        // } catch (error) {
        //   throw new Error("Error uploading files to S3!");
        // }
        await updatedUser.save();
      }

      if (
        !(
          Object.keys(update).length === 1 &&
          typeof update.addTimeStampToImages === "boolean"
        )
      ) {
        await NotificationsHelpers.create(
          req.user._id,
          companyId,
          NotificationMessageKey.PROFILE_UPDATED,
          req.user._id,
        );
      }

      // For Future Reference :--> Send Push Notification (mobile app)
      // await NotificationsHelpers.sendNotification(userId);

      const token = getJWTToken(updatedUser);

      return SuccessResponse(res, status.OK, {
        message: "User profile updated successfully",
        data: {
          token,
          user: updatedUser,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  // Normalizes + format-validates a new email/phone. Email is lowercased to
  // match how it is stored/looked up everywhere; phone must be E164.
  private static normalizeContactValue = (
    type: CONTACT_CHANGE_TYPE,
    raw: string,
  ): { newValue?: string; error?: string } => {
    const trimmed = (raw || "").trim();

    if (type === CONTACT_CHANGE_TYPE.EMAIL) {
      const email = trimmed.toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return { error: "Please enter a valid email address." };
      }
      return { newValue: email };
    }

    // Firebase (and E.164) require a leading "+"; TwilioMessageService.validE164
    // treats it as optional, which would let a "+"-less value bypass the
    // uniqueness check (existing phones are stored with "+") and then fail the
    // Firebase gate after the OTP was already sent. Enforce the "+" here.
    const E164_WITH_PLUS = /^\+[1-9]\d{1,14}$/;
    if (!E164_WITH_PLUS.test(trimmed)) {
      return {
        error: "Phone number must be in E.164 format (e.g. +14155550123).",
      };
    }
    return { newValue: trimmed };
  };

  public static requestContactChangeReauth = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        channel: "required|in:email,phone",
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const channel: CONTACT_CHANGE_TYPE = req.body.channel;
      const userId = req.user._id;
      const currentValue = req.user[channel];

      if (!currentValue) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: `Your account has no ${channel} to verify. Please use the other option.`,
        });
      }

      if (channel === CONTACT_CHANGE_TYPE.PHONE) {
        // Firebase sends (and throttles) the SMS from the client.
        return SuccessResponse(res, status.OK, {
          message:
            "Verify your current phone number with the code Firebase sends.",
        });
      }

      const otp = randomInt(10000, 100000).toString();
      const expiresAt = new Date(
        Date.now() + UserRoutes.CONTACT_OTP_EXPIRY_MINUTES * 60 * 1000,
      );
      const cooldownCutoff = new Date(
        Date.now() - UserRoutes.CONTACT_OTP_RESEND_COOLDOWN_MS,
      );
      const claimed = await UserHelper.claimReauthSlot({
        userId,
        channel,
        otp,
        expiresAt,
        cooldownCutoff,
      });
      if (!claimed) {
        return ErrorResponse(res, status.TOO_MANY_REQUESTS, {
          message: "Please wait a moment before requesting another code.",
        });
      }

      try {
        const emailService = new EmailService();
        const sent = await emailService.sendOtpMail({
          email: currentValue,
          otp,
        });
        if (!sent) {
          throw new Error("Failed to send the verification email.");
        }
      } catch (sendError) {
        await UserHelper.discardClaimedReauth(userId, otp);
        throw sendError;
      }

      return SuccessResponse(res, status.OK, {
        message: "A verification code has been sent to your current email.",
      });
    } catch (error) {
      next(error);
    }
  };

  // Step 0b: verify the re-auth proof (email OTP, or Firebase idToken for the
  // CURRENT phone) and open a single-use grant for the actual change.
  public static verifyContactChangeReauth = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        channel: "required|in:email,phone",
        otp: "string",
        accessToken: "string",
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const channel: CONTACT_CHANGE_TYPE = req.body.channel;
      const userId = req.user._id;
      const grantExpiresAt = new Date(
        Date.now() + UserRoutes.REAUTH_GRANT_TTL_MS,
      );

      if (channel === CONTACT_CHANGE_TYPE.PHONE) {
        const accessToken = req.body.accessToken;
        if (!accessToken || typeof accessToken !== "string") {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "accessToken is required to verify by phone.",
          });
        }
        if (!req.user.phone) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Your account has no phone number to verify.",
          });
        }

        let decoded: Awaited<ReturnType<typeof firebaseService.verifyIdToken>>;
        try {
          decoded = await firebaseService.verifyIdToken(accessToken);
        } catch (tokenError) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Invalid verification. Please request a new code.",
          });
        }

        // Must prove possession of the user's CURRENT phone number.
        if (decoded.phone_number !== req.user.phone) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message:
              "The verified phone number does not match your current number.",
          });
        }
        if (
          Date.now() - decoded.auth_time * 1000 >
          UserRoutes.CONTACT_PHONE_TOKEN_MAX_AGE_MS
        ) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message:
              "This verification has expired. Please verify your number again.",
          });
        }
      } else {
        const otp = req.body.otp ? String(req.body.otp) : "";
        if (!otp) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "otp is required to verify by email.",
          });
        }

        // Same atomic attempt/expiry/cap/match machinery as the change flow.
        const pending = await UserHelper.registerReauthAttempt(userId);
        if (!pending || pending.get("channel") !== channel) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "No pending verification. Please request a new code.",
          });
        }
        if (pending.get("verifiedAt")) {
          // Already a grant — a stray re-submit shouldn't burn it.
          return SuccessResponse(res, status.OK, {
            message: "Already verified.",
          });
        }
        if (new Date(pending.get("expiresAt")).getTime() < Date.now()) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "This code has expired. Please request a new one.",
          });
        }
        if (pending.get("attempts") > UserRoutes.CONTACT_OTP_MAX_ATTEMPTS) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Too many incorrect attempts. Please request a new code.",
          });
        }
        if (pending.get("otp") !== otp) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Invalid verification code.",
          });
        }
      }

      await UserHelper.upsertReauthGrant(userId, channel, grantExpiresAt);

      return SuccessResponse(res, status.OK, {
        message: "Verified. You can now change your email or phone number.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static requestContactChange = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        type: "required|in:email,phone",
        newValue: "required|string",
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const type: CONTACT_CHANGE_TYPE = req.body.type;
      const { newValue: normalized, error: normErr } =
        UserRoutes.normalizeContactValue(type, req.body.newValue);
      if (normErr || !normalized) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: normErr,
        });
      }

      const userId = req.user._id;

      // Must have verified a CURRENT contact first (single-use grant).
      const reauthGrant = await UserHelper.getActiveReauthGrant(userId);
      if (!reauthGrant) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message:
            "Please verify your current email or phone number before making this change.",
        });
      }

      const currentValue = req.user[type];

      if (currentValue && currentValue === normalized) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: `This is already your ${type}.`,
        });
      }

      // Uniqueness — there is no DB unique index on email/phone yet.
      const inUse = await UserHelper.isContactInUse(type, normalized, userId);
      if (inUse) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: `This ${type} is already in use.`,
        });
      }

      if (type === CONTACT_CHANGE_TYPE.PHONE) {
        return SuccessResponse(res, status.OK, {
          message: "Phone number is available for verification.",
        });
      }

      // crypto.randomInt (not Math.random) — this code gates a login-identity
      // change, so it must not be predictable from the PRNG state.
      const otp = randomInt(10000, 100000).toString();
      const expiresAt = new Date(
        Date.now() + UserRoutes.CONTACT_OTP_EXPIRY_MINUTES * 60 * 1000,
      );

      const cooldownCutoff = new Date(
        Date.now() - UserRoutes.CONTACT_OTP_RESEND_COOLDOWN_MS,
      );
      const claimed = await UserHelper.claimContactChangeSlot({
        userId,
        type,
        newValue: normalized,
        otp,
        expiresAt,
        cooldownCutoff,
      });
      if (!claimed) {
        return ErrorResponse(res, status.TOO_MANY_REQUESTS, {
          message: "Please wait a moment before requesting another code.",
        });
      }

      try {
        const emailService = new EmailService();
        const sent = await emailService.sendOtpMail({
          email: normalized,
          otp,
        });
        if (!sent) {
          throw new Error("Failed to send the verification email.");
        }
      } catch (sendError) {
        // The claim above set the resend-cooldown clock. If delivery fails, roll
        // back only the doc we just claimed (scoped by otp) so the user isn't
        // locked out holding a code they never received, without clobbering a
        // newer claim that may have refreshed the slot.
        await UserHelper.discardClaimedContactChange(userId, type, otp);
        throw sendError;
      }

      return SuccessResponse(res, status.OK, {
        message: `A verification code has been sent to your new ${type}.`,
      });
    } catch (error) {
      next(error);
    }
  };

  public static verifyContactChange = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        type: "required|in:email,phone",
        newValue: "required|string",
        otp: "string",
        accessToken: "string",
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const type: CONTACT_CHANGE_TYPE = req.body.type;
      const { newValue: normalized, error: normErr } =
        UserRoutes.normalizeContactValue(type, req.body.newValue);
      if (normErr || !normalized) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: normErr,
        });
      }

      const userId = req.user._id;

      // The re-auth grant must still be live at commit time too.
      const reauthGrant = await UserHelper.getActiveReauthGrant(userId);
      if (!reauthGrant) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message:
            "Please verify your current email or phone number before making this change.",
        });
      }

      // Firebase account that proved possession of the new phone number (only
      // set for phone changes).
      let verifiedPhoneUid: string | undefined;

      if (type === CONTACT_CHANGE_TYPE.PHONE) {
        const accessToken = req.body.accessToken;
        if (!accessToken || typeof accessToken !== "string") {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "accessToken is required to verify a phone change.",
          });
        }

        let decoded: Awaited<ReturnType<typeof firebaseService.verifyIdToken>>;
        try {
          decoded = await firebaseService.verifyIdToken(accessToken);
        } catch (tokenError) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Invalid verification. Please request a new code.",
          });
        }

        // The token must prove possession of exactly the number being committed.
        if (decoded.phone_number !== normalized) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message:
              "The verified phone number does not match the requested number.",
          });
        }

        // Require a fresh Firebase sign-in so an idToken captured earlier can't
        // be replayed to re-run the change later.
        if (
          Date.now() - decoded.auth_time * 1000 >
          UserRoutes.CONTACT_PHONE_TOKEN_MAX_AGE_MS
        ) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message:
              "This verification has expired. Please verify your number again.",
          });
        }

        verifiedPhoneUid = decoded.uid;
      } else {
        const otp = req.body.otp ? String(req.body.otp) : "";
        if (!otp) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "otp is required to verify an email change.",
          });
        }

        const pending = await UserHelper.registerContactChangeAttempt(
          userId,
          type,
        );
        if (!pending) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "No pending change request. Please request a new code.",
          });
        }

        // Expired (the TTL sweep may not have removed it yet). Do NOT delete here:
        // the doc's updatedAt is the resend-cooldown clock, and deleting it would
        // let a caller reset the cooldown at will (email bomb). TTL reaps it.
        if (new Date(pending.get("expiresAt")).getTime() < Date.now()) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "This code has expired. Please request a new one.",
          });
        }

        // Attempt cap to stop brute forcing a 5-digit code (attempt already counted
        // atomically above). Do NOT delete the doc — keeping it preserves the
        // cooldown clock so exhausting attempts can't be used to bypass the resend
        // throttle; the user re-requests once the cooldown elapses.
        if (pending.get("attempts") > UserRoutes.CONTACT_OTP_MAX_ATTEMPTS) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Too many incorrect attempts. Please request a new code.",
          });
        }

        // Code must match AND be for the same value that was requested.
        if (
          pending.get("otp") !== otp ||
          pending.get("newValue") !== normalized
        ) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Invalid verification code.",
          });
        }

        // Single-winner gate: atomically consume the pending change, pinned to this
        // exact otp+value, so a concurrent duplicate verify can't commit twice (the
        // loser gets null) and a concurrent re-request that swapped the target value
        // can't be committed under the old value. The consumed doc is the point of
        // no return for the DB writes below.
        const consumed = await UserHelper.consumePendingContactChange(
          userId,
          type,
          otp,
          normalized,
        );
        if (!consumed) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "This verification code has already been used.",
          });
        }
      }

      // Re-check uniqueness at commit — someone may have claimed it since request.
      const inUse = await UserHelper.isContactInUse(type, normalized, userId);
      if (inUse) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: `This ${type} is already in use.`,
        });
      }

      const oldValue = req.user[type];
      const firebaseUid = req.user.firebaseUid;

      // Hard gate: Firebase Auth first. Abort with Mongo untouched on failure.
      try {
        if (type === CONTACT_CHANGE_TYPE.EMAIL) {
          if (firebaseUid) {
            await firebaseService.updateUserEmail(firebaseUid, normalized);
          }
        } else if (verifiedPhoneUid !== firebaseUid) {
          // The client-side Firebase verification signed into a throwaway
          // account that now owns the new number. Release it first (Firebase
          // enforces phone uniqueness) — but only if no registered user owns
          // that uid, so a real account is never deleted.
          if (verifiedPhoneUid) {
            const uidOwner =
              await UserHelper.findByFirebaseUid(verifiedPhoneUid);
            if (!uidOwner) {
              try {
                await firebaseService.deleteUser(verifiedPhoneUid);
              } catch (cleanupError) {
                // Non-fatal: if the throwaway survives, updateUserPhone below
                // fails with phone-number-already-exists ("already in use").
                console.error(
                  "Contact change: throwaway Firebase user cleanup failed",
                  cleanupError?.message,
                );
              }
            }
          }
          if (firebaseUid) {
            await firebaseService.updateUserPhone(firebaseUid, normalized);
          }
        }
        // verifiedPhoneUid === firebaseUid → the user's own Firebase account
        // already carries the new number; nothing to update.
      } catch (fbError) {
        const code = fbError?.code || fbError?.errorInfo?.code;
        if (
          code === "auth/email-already-exists" ||
          code === "auth/phone-number-already-exists"
        ) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: `This ${type} is already in use.`,
          });
        }
        if (
          code === "auth/invalid-email" ||
          code === "auth/invalid-phone-number"
        ) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `Please enter a valid ${type}.`,
          });
        }
        // An email code was already consumed above, so retrying the same code
        // won't work — tell the user to request a fresh one.
        return ErrorResponse(res, status.BAD_REQUEST, {
          message:
            "Could not update your login right now. Please request a new code and try again.",
        });
      }

      let updatedUser: Awaited<
        ReturnType<typeof UserHelper.updateUserContactField>
      >;
      try {
        updatedUser = await UserHelper.updateUserContactField(
          userId,
          type,
          normalized,
        );
      } catch (mongoError) {
        // Firebase was already updated by the hard gate above. Revert it
        // best-effort so the two stores don't diverge, then surface the failure.
        if (firebaseUid && oldValue) {
          try {
            if (type === CONTACT_CHANGE_TYPE.EMAIL) {
              await firebaseService.updateUserEmail(firebaseUid, oldValue);
            } else {
              await firebaseService.updateUserPhone(firebaseUid, oldValue);
            }
          } catch (revertError) {
            console.error(
              "Contact change: Firebase revert after Mongo failure failed",
              revertError?.message,
            );
          }
        } else if (firebaseUid) {
          // Add-contact case (no prior value): Firebase can't be unset here, so
          // Firebase and Mongo may diverge — log for manual reconciliation.
          console.error(
            "Contact change: Mongo write failed after Firebase update with no prior value to revert; possible desync for user",
            `${userId}`,
          );
        }
        throw mongoError;
      }

      // User was deleted between auth and commit — don't mint a token for a null
      // user (jwtDecoder would then read _id off null and lock the account out).
      if (!updatedUser) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "User not found.",
        });
      }

      // Stale login OTPs for the old/new value, plus the single-use re-auth
      // grant — best-effort: the change is already applied, so a failure here
      // must not fail the response. (The pending change itself was already
      // consumed by the single-winner gate.)
      try {
        await Promise.all([
          oldValue
            ? UserHelper.deleteLoginOtps(type, oldValue)
            : Promise.resolve(),
          UserHelper.deleteLoginOtps(type, normalized),
          UserHelper.consumeReauthGrant(userId),
        ]);
      } catch (cleanupError) {
        console.error(
          "Contact change: post-commit cleanup failed",
          cleanupError?.message,
        );
      }

      // Fire-and-forget: external syncs + the old-contact alert must never block
      // or fail the response (the change is already durably committed). Each
      // provider is logged inside these helpers; the .catch here is only an
      // unhandled-rejection backstop.
      // NOTE: failures currently land in console.error (see the inner handlers);
      // routing them to a monitored channel is a tracked follow-up.
      UserRoutes.syncContactChangeToExternalSystems({
        type,
        newValue: normalized,
        oldValue,
        userId: `${userId}`,
        stripeCustomerId: req.user.stripeCustomerId,
        email: req.user.email,
        name: req.user.name,
      }).catch(() => undefined);

      UserRoutes.notifyOldContact({
        type,
        oldValue,
        newValue: normalized,
      }).catch(() => undefined);

      const token = getJWTToken(updatedUser);

      return SuccessResponse(res, status.OK, {
        message: `Your ${type} has been updated successfully.`,
        data: { token, user: updatedUser },
      });
    } catch (error) {
      next(error);
    }
  };

  // Keeps third-party systems consistent after a contact change. Every call is
  // isolated so one failing provider can't block the change or the others.
  private static syncContactChangeToExternalSystems = async (params: {
    type: CONTACT_CHANGE_TYPE;
    newValue: string;
    oldValue?: string;
    userId: string;
    stripeCustomerId?: string;
    email?: string;
    name?: { first?: string; last?: string };
  }) => {
    const { type, newValue, oldValue, userId, stripeCustomerId, email, name } =
      params;

    if (type === CONTACT_CHANGE_TYPE.EMAIL) {
      if (stripeCustomerId) {
        try {
          await stripeService.updateCustomerEmail(stripeCustomerId, newValue);
        } catch (error) {
          console.error(
            "Contact change: Stripe email sync failed",
            error?.message,
          );
        }
      }

      try {
        await addUserToGetStreamClient({
          id: userId,
          name: `${name?.first || ""} ${name?.last || ""}`.trim(),
          email: newValue,
        });
      } catch (error) {
        console.error("Contact change: GetStream sync failed", error?.message);
      }

      // Lead is keyed by its current (old) email; update-only, never creates.
      try {
        await SalesForceService.updateLeadContact(oldValue, {
          Email: newValue,
        });
      } catch (error) {
        console.error(
          "Contact change: Salesforce email sync failed",
          error?.message,
        );
      }
    } else {
      // Phone change: the lead is keyed by email (unchanged) — patch the Phone.
      if (email) {
        try {
          await SalesForceService.updateLeadContact(email, { Phone: newValue });
        } catch (error) {
          console.error(
            "Contact change: Salesforce phone sync failed",
            error?.message,
          );
        }
      }
    }
  };

  // Alerts the user's OLD email/phone that their login was changed. Best-effort:
  // it is a safety net, not a gate, so failures are swallowed.
  private static notifyOldContact = async (params: {
    type: CONTACT_CHANGE_TYPE;
    oldValue?: string;
    newValue: string;
  }) => {
    const { type, oldValue, newValue } = params;
    if (!oldValue) return;

    try {
      if (type === CONTACT_CHANGE_TYPE.EMAIL) {
        const emailService = new EmailService();
        await emailService.sendContactChangedEmail({
          email: oldValue,
          changedField: "email",
          newValue,
        });
      } else {
        const messageService = new TwilioMessageService();
        await messageService.sendPlainMessage(
          oldValue,
          `Your CrewCam login phone number was changed to ${newValue}. If this wasn't you, contact us: ${CONTACT_US_URL}`,
        );
      }
    } catch (error) {
      console.error(
        "Contact change: old-contact notification failed",
        error?.message,
      );
    }
  };

  public static changePassword = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        currentPassword: "required",
        newPassword: "required",
        confirmedPassword: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { currentPassword, newPassword, confirmedPassword } = req.body;

      if (newPassword !== confirmedPassword) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "New password and confirmed password do not match",
        });
      }

      const userId = req.user._id;
      const companyId = req.user.companyId;

      try {
        await firebaseService.signInUser(req.user.email, currentPassword);
      } catch (err) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "Invalid Password.",
        });
      }

      try {
        await firebaseService.updateUserPassword(
          req.user.firebaseUid,
          newPassword,
        );
        await NotificationsHelpers.create(
          userId,
          companyId,
          NotificationMessageKey.PASSWORD_CHANGED,
        );

        // For Future Reference :--> Send notification
        // await NotificationsHelpers.sendNotification(userId);
      } catch (err) {
        return ErrorResponse(res, status.INTERNAL_SERVER_ERROR, {
          message: `Failed to update password`,
        });
      }

      const token = getJWTToken(req.user);

      return SuccessResponse(res, status.OK, {
        message: `Changed password successfully`,
        data: { user: req.user, token },
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteAccount = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      let deleteUsers = [req.user];
      if (
        req?.user?.companies?.[0]?.role &&
        req.user.companies[0].role == USER_ROLE.ADMIN
      ) {
        const [users, projectIds] = await Promise.all([
          CompanyHelpers.getCompanyMembers(req.user.companyId),
          ProjectHelper.getCompanyProjects(req.user.companyId),
        ]);
        const userIds = users.map((u) => u.userId);

        const [posts, projectNotes, userFireBaseIds] = await Promise.all([
          UserHelper.getPostIds(projectIds),
          UserHelper.getProjectNoteIds(projectIds),
          UserHelper.getUsersFireBaseId(userIds),
        ]);

        deleteUsers = userFireBaseIds;
        const postIds = posts.map((p) => p._id);
        const projectNotesIds = projectNotes.map((p) => p._id);

        const getComments = await UserHelper.getCommentIds(
          projectIds,
          postIds,
          projectNotesIds,
        );

        let commentIds = [];

        getComments.map((a) => {
          const temp = a.map((a) => a._id);
          commentIds = [...commentIds, ...temp];
        });

        const getReplys = await UserHelper.getReplys(commentIds);
        const replyIds = getReplys.map((a) => a._id);
        commentIds = [...commentIds, ...replyIds];

        await Promise.all([
          UserHelper.deleteCompany(req.user.companyId),
          UserHelper.removeCompanyMembers(req.user.companyId),
          UserHelper.removeProjects(req.user.companyId),
          UserHelper.removeCompanyTags(req.user.companyId),
          UserHelper.deleteInvites(req.user.companyId),
          UserHelper.removeProjectMembers(projectIds),
          UserHelper.removeProjectPins(projectIds),
          UserHelper.deleteProjectTasks(projectIds),
          UserHelper.deleteProjectNotes(projectIds),
          UserHelper.deletePosts(postIds),
          UserHelper.deleteReports(postIds),
          UserHelper.removeComments(
            projectIds,
            postIds,
            projectNotesIds,
            replyIds,
          ),
          UserHelper.deleteLikes(commentIds, projectNotesIds),
          UserHelper.deleteNotifications(userIds),
        ]);
      }

      await Promise.all(
        deleteUsers.map(async (user) => {
          await Promise.all([
            UserHelper.clearUserDataExceptNameAndImage(user._id),
            UserHelper.deleteUserCompanyProfile(user._id),
            UserHelper.deleteUserProjectProfile(user._id),
            firebaseService.deleteUser(user.firebaseUid),
            UserHelper.deleteNotifications([user._id]),
            UserHelper.deleteFcmToken(user._id),
            UserHelper.removeUserFromCrews(user._id),
          ]);
        }),
      );

      if (
        req?.user?.companies?.[0]?.role &&
        req.user.companies[0].role == USER_ROLE.ADMIN
      ) {
        await UserHelper.deleteMultipleUserprofiles(
          deleteUsers.map((user) => user._id),
        );
      }

      return SuccessResponse(res, status.OK, {
        message: `Account deleted successfully`,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getOtp = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        email: "email|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { email } = req.body;
      const otp = Math.floor(10000 + Math.random() * 90000).toString();

      await AuthHelpers.updateOtp(email, otp);

      const emailService = new EmailService();
      await emailService.sendOtpMail({
        email,
        otp,
      });

      return SuccessResponse(res, status.OK, {
        message: `Otp sent successfully`,
      });
    } catch (error) {
      next(error);
    }
  };

  public static verifyAndDelete = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        otp: "required",
        email: "email|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "OTP or Phone Required!",
          errors: validator.errors,
        });
      }

      const { otp, email } = req.body;

      const otpExists = await AuthHelpers.findOneOtp({ email, otp });

      if (!otpExists) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid OTP!",
          errors: validator.errors,
        });
      }

      const user: any = await UserHelper.findOne({ email });
      if (user) {
        const companys = await CompanyHelpers.getMyCompanies(user._id);
        if (companys && companys.length) {
          user.companies = companys;
          user.companyId = companys[0].companyId;
        }
        req.user = user;
        const response: any = {};
        await this.deleteAccount(req, response, next);
      }

      return SuccessResponse(res, status.OK, {
        message: `Otp found successfully`,
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateRole = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        userId: "required",
        userRole: "required|string|maxLength:100",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { userId, userRole } = req.body;
      const { _id, roles, companyId } = req.user;

      const trimmedRole = userRole.trim();
      if (!trimmedRole) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Designation cannot be empty",
        });
      }

      if (_id.equals(userId)) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "unauthorized user",
        });
      }

      // Requester may only edit members ranked below them within the same
      // company (mirrors the web app's allowChangeUserAccess hierarchy).
      const targetMember: any = await CompanyHelpers.getCompanyMemberRole(
        companyId,
        ObjectId(userId),
      );

      if (!targetMember || !canEditMemberInfo(roles, targetMember.role)) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "unauthorized user",
        });
      }

      const update = { userRole: trimmedRole };

      await UserHelper.findByIdAndUpdate(ObjectId(userId), update);

      return SuccessResponse(res, status.OK, {
        message: "User profile updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateSettings = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        homePageSortBy: "string|in:oldest,NEWEST,dateTakenAsc,dateTakenDesc",
        language: `string|in:${SUPPORTED_LANGUAGES.join(",")}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { homePageSortBy, language } = req.body;
      const userId = req.user._id;

      // Partial update: only touch what the payload contains, so a language
      // change never clears homePageSortBy and vice versa.
      if (language !== undefined) {
        await UserHelper.findByIdAndUpdate(userId, { language });
      }

      if (homePageSortBy !== undefined) {
        const userSettings = await UserHelper.getUserSettings(userId);

        const update = {
          userId,
          ...userSettings,
          homePageView: { sortBy: homePageSortBy },
        };

        await UserHelper.updateUsersSettings(userId, update);
      }

      return SuccessResponse(res, status.OK, {
        message: "User settings updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
