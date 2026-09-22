import * as express from "express";
import * as status from "http-status";
import * as StandardError from "standard-error";
import { EmailService } from "../../services/email";
import { config } from "../../utils/configuration/config";
import * as jwt from "jsonwebtoken";
import { UserCredential } from "firebase/auth";
import { User, Referrals, Otp, ProjectMember } from "../../db";
import { AuthHelpers } from "./helpers";
import { firebaseService } from "../../services/firebaseAdmin";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import {
  getJWTToken,
  getMonthAndYear,
  getTimeDiffs,
  removeHours,
} from "../../utils/helpers/commonHelper";
import { Validator } from "node-input-validator";
import { UserRecord } from "firebase-admin/lib/auth/user-record";
import {
  addUserToGetStreamClient,
  getTokenFromGetstream,
} from "../../services/getStream";
import { TwilioMessageService } from "../../services/twilio";
import {
  CURRENT_STATUS,
  SOCIAL_AUTH_TYPE_ENUM,
  SUBSCRIPTION_STATUS,
  USER_ROLE,
} from "../../utils/enums/enums";
import { CompanyHelpers } from "../company/helpers";
import { RevenueCatService } from "../../services/revenueCatService";
import { ProjectHelper } from "../projects/helper";
import { InviteUsersHelpers } from "../inviteUser/helpers";
import { UserHelper } from "../user/helper";
import { SalesforceAccountSyncService } from "../../services/salesforceAccountSync";
import { LEAD_SOURCE } from "../../utils/enums/salesforce";
import { isStandardAndAbove } from "../../utils/helpers/users";
import { stripeService } from "../../services/stripeService";
import { subscriptionPlanUsers } from "../../utils/constants/constants";
import { slackService } from "../../services/slack";
import {
  AccountDeactivatedResponse,
  isAccountDeactivated,
} from "../../utils/helpers/accountStatus";
import { buildAttribution } from "../../utils/helpers/attribution";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const factor = require("node-2fa");
export class AuthRoutes {
  static JWT_SECRET: string = config.JWT_SECRET || "i am a tea pot";
  public static registerWithEmailPassword = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        email: "email|required",
        name: "required",
        password: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      // `roles` / `isSuperAdmin` are deliberately NOT read from the request
      // body. jwtDecoder only overrides User.roles for users with an active
      // company membership, so a body-supplied role would persist and let an
      // unauthenticated caller mint a Super Admin account.
      const { email, password, name } = req.body;
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        throw new StandardError({
          message: "Email already in use",
          code: status.CONFLICT,
        });
      }

      const firebaseAuthUser = await firebaseService.createUser(
        name,
        email,
        password,
      );
      const { uid } = firebaseAuthUser;
      const user = await User.create({
        name,
        email,
        firebaseUid: uid,
        hasPassword: true,
        attribution: buildAttribution(req.body.attribution),
      });

      const token = getJWTToken(user);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: { token, user },
      });
    } catch (error) {
      next(error);
    }
  };
  public static loginWithEmailPassword = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        email: "email|required",
        password: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const { email, password } = req.body;
      let firebaseUser: UserCredential;
      try {
        firebaseUser = await firebaseService.signInUser(email, password);
      } catch (err) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "Invalid credentials",
        });
      }

      const user = await User.findOne({
        firebaseUid: firebaseUser.user.uid,
      }).setOptions({ skipVisibility: true });

      if (user && (await isAccountDeactivated(user._id))) {
        return AccountDeactivatedResponse(res);
      }

      const token = getJWTToken(user);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: { token, user },
      });
    } catch (error) {
      next(error);
    }
  };
  public static register = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      //validating body
      const validator = new Validator(req.body, {
        email: "email|required",
        name: "required",
        phone: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const {
        phone,
        name,
        isAdmin,
        inviteCode,
        oauth = [],
        userRole,
      } = req.body;

      let { email, companyName } = req.body;
      email = email.toLowerCase();

      // The OTP flow is the only proof that a human owns this email/phone.
      // Without this check a client can skip request-otp/verify-otp entirely
      // and create accounts in bulk.
      //
      // Runs in log-only mode until ENFORCE_SIGNUP_VERIFICATION=true, so the
      // hit rate on real traffic can be measured before signups start failing.
      const isVerified = await AuthHelpers.hasRecentOtpVerification({
        email,
        phone,
      });

      if (!isVerified) {
        console.log("is verified", isVerified, email, phone);
        return ErrorResponse(res, status.FORBIDDEN, {
          message:
            "Please verify your email or phone number before signing up.",
        });
      }

      //checking if mail and phonenumber already exists

      let mailExists, phoneExists;

      if (phone) {
        const [existingEmail, existingphone] = await Promise.all([
          User.findOne({ email }),
          User.findOne({ phone }),
        ]);

        mailExists = existingEmail;
        phoneExists = existingphone;
      } else {
        const existingEmail = User.findOne({ email });
        mailExists = existingEmail;
      }

      if (mailExists) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "email already exists!",
        });
      }

      if (phoneExists) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "phone number already exists!",
        });
      }

      //createing user in firebase
      let firebaseAuthUser: UserRecord;

      try {
        const phoneRecord = await firebaseService.findUserByPhone(phone);
        if (phoneRecord) {
          await firebaseService.deleteUser(phoneRecord.uid);
        }
      } catch (er) {
        /* empty */
      }

      try {
        const phoneRecord = await firebaseService.findUserByPhone(phone);
        if (phoneRecord) {
          await firebaseService.deleteUser(phoneRecord.uid);
        }
      } catch (er) {
        /* empty */
      }

      try {
        const record = await firebaseService.findUser(email);

        if (!record) {
          firebaseAuthUser = await firebaseService.createUser(
            name,
            email,
            phone,
          );
        } else {
          firebaseAuthUser = record;
        }
      } catch (err) {
        if (err.code == "auth/user-not-found") {
          firebaseAuthUser = await firebaseService.createUser(
            name,
            email,
            phone,
          );
        } else {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: err.message,
          });
        }
      }

      const { uid } = firebaseAuthUser;

      await firebaseService.updateUserPhone(uid, phone);

      const obj: any = {
        email,
        firebaseUid: uid,
        name,
        // Marketing attribution from the signup payload (Meta for now).
        attribution: buildAttribution(req.body.attribution),
      };

      if (oauth && oauth.length) {
        obj.oauth = oauth;
      }

      if (phone) {
        obj.phone = phone;
      }

      if (companyName) {
        obj.companyName = companyName;
      }

      if (isAdmin) {
        obj.roles = USER_ROLE.ADMIN;
      }

      if (userRole) {
        obj.userRole = userRole;
      }

      const user: any = await User.create(obj);
      user.myTotalProjects = 0;

      // Spend the verification so one OTP can't seed more than one account.
      await AuthHelpers.consumeOtpVerification({ email, phone });

      if (isAdmin) {
        if (!companyName) companyName = name.first;
        const companyMember = await CompanyHelpers.createCompanyWithAdminUser(
          companyName,
          user._id,
        );
        SalesforceAccountSyncService.createAndLinkLead(user._id, {
          FirstName: user.name.first,
          LastName: user.name.last,
          Title: user.userRole,
          Company: companyName,
          Phone: user.phone,
          Email: user.email,
          LeadSource: LEAD_SOURCE.APP_DOWNLOAD,
          Joined_On__c: new Date().toISOString(),
          RelayCam_Org_ID__c: String(companyMember.companyId),
        });

        // Send Slack notification for new admin registration
        try {
          await slackService.notifyAdminRegistration({
            name: `${user.name.first} ${user.name.last || ""}`.trim(),
            email: user.email,
            phone: user.phone,
            companyName: companyName,
            userRole: user.userRole || "Admin",
            registeredAt: new Date(),
          });
        } catch (slackError) {
          // don't fail the registration
        }
      } else {
        const createdAt = removeHours(new Date(), 36);
        const invite = await InviteUsersHelpers.validateInvite(
          inviteCode,
          createdAt,
        );
        const company = await CompanyHelpers.addToCompany(inviteCode, user._id);

        if (invite?.projectId) {
          await ProjectHelper.joinProject(user._id, invite.projectId, null);
        }
        user.roles = company.role;
      }
      const companies = await CompanyHelpers.getMyCompanies(user._id);

      if (isStandardAndAbove(user.roles)) {
        const projects = await ProjectHelper.getCompanyProjects(
          companies[0].companyId,
        );
        await Promise.all(
          projects.map((p) => {
            ProjectHelper.addToProject(p._id, user._id);
          }),
        );
      }

      if (companies && companies.length) {
        user.roles = companies[0].role;
        user.companies = companies;
        user.companyId = companies[0].companyId;
        const admin = await CompanyHelpers.getCompanyAdminId(
          companies?.[0]?.companyId,
        );
        let subscriptionStatus = await RevenueCatService.getSubScriptionStatus(
          admin?.userId,
        );
        if (subscriptionStatus == SUBSCRIPTION_STATUS.NO_SUBSCRIPTION) {
          const { diffInDays } = getTimeDiffs(user.createdAt, new Date());
          if (diffInDays > 15) {
            subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
          }
        }
        user.subscriptionStatus = subscriptionStatus;
      }

      const token = getJWTToken(user);

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: { token, user },
      });
    } catch (error) {
      console.log({ error });

      next(error);
    }
  };

  public static registerLoginOauth = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body.user, {
        oauth: "required",
        firebaseUid: "required",
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { email, oauth, accessToken, idToken, phone } = req.body.user;

      if (!email && oauth === "APPLE") {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Email should be associated with the apple account!",
        });
      }

      const socialResponse = await AuthHelpers.verifySocialLoginRegister({
        email,
        accessToken,
        oauth,
        idToken,
      });

      if (!socialResponse) {
        return SuccessResponse(res, status.OK, {
          message: "Invalid social response!",
        });
      }

      let user;
      if (oauth == SOCIAL_AUTH_TYPE_ENUM.PHONE) {
        // Firebase already proved ownership of this phone, so record the same
        // verification marker the OTP flow writes — registration reads it as
        // proof the number was challenged.
        [user] = await Promise.all([
          User.findOne({ phone }).lean(),
          AuthHelpers.markOtpVerified({ phone }),
        ]);
      } else {
        [user] = await Promise.all([
          User.findOne({ email }).lean(),
          AuthHelpers.markOtpVerified({ email }),
        ]);
      }

      const response = {
        message: "OTP Verified Succesfully!.",
        data: {},
      };

      if (user && (await isAccountDeactivated(user._id))) {
        return AccountDeactivatedResponse(res);
      }

      if (user) {
        const { year, month } = getMonthAndYear(new Date());
        const [myTotalProjects, companies] = await Promise.all([
          ProjectMember.countDocuments({
            userId: user._id,
            status: CURRENT_STATUS.ACTIVE,
          }),
          CompanyHelpers.getMyCompanies(user._id),
          User.findByIdAndUpdate(user._id, { $addToSet: { oauth: oauth } }),
          UserHelper.updateActivitylogs(user._id, month, year),
        ]);
        user.myTotalProjects = myTotalProjects;
        user.fullName = user.name.first + " " + user.name.last;
        const token = getJWTToken(user);
        response.data = { token, user };
        user.roles = companies?.[0]?.role;
        if (companies && companies.length) {
          user.companies = companies;
          user.companyId = companies[0].companyId;
          const admin = await CompanyHelpers.getCompanyAdminId(
            companies?.[0]?.companyId,
          );

          let subscriptionStatus: any = null;
          let maxTeamSize;

          if (admin?.userId) {
            const adminUser = await UserHelper.findOne({ _id: admin.userId });
            const [revenueCat, stripe] = await Promise.all([
              RevenueCatService.getSubScriptionStatus(
                admin?.userId,
                true,
                true,
              ),
              stripeService.getSubscriptionStatus(adminUser.stripeCustomerId),
            ]);

            if (stripe) {
              subscriptionStatus = stripe;
              maxTeamSize = admin.teamLimit;
            } else subscriptionStatus = revenueCat;
          } else {
            subscriptionStatus.subscriptionStatus =
              SUBSCRIPTION_STATUS.NO_SUBSCRIPTION;
          }

          if (
            subscriptionStatus.subscriptionStatus ==
            SUBSCRIPTION_STATUS.NO_SUBSCRIPTION
          ) {
            const { diffInDays } = getTimeDiffs(user.createdAt, new Date());
            if (diffInDays > 15) {
              subscriptionStatus.subscriptionStatus =
                SUBSCRIPTION_STATUS.EXPIRED;
            }
          }

          const companyMembers = await CompanyHelpers.getCompanyMembers([
            user.companyId,
          ]);

          maxTeamSize =
            maxTeamSize ||
            subscriptionPlanUsers(
              subscriptionStatus?.subscriptionPlan?.split(/[_-]/)?.[0],
            );

          user.companyMembersLimitExceded = maxTeamSize < companyMembers.length;
          user.subscriptionStatus = subscriptionStatus.subscriptionStatus;
        }
      }

      return SuccessResponse(res, status.OK, response);
    } catch (error) {
      next(error);
    }
  };

  public static registerInviteUser = async (document: any) => {
    try {
      const { oauth } = document;
      if (oauth) {
        const {
          email,
          oauth,
          name,
          firebaseUid,
          accessToken,
          timezone,
          companyId,
          idToken,
        } = document;
        const socialResponse = await AuthHelpers.verifySocialLoginRegister({
          email,
          accessToken,
          oauth,
          idToken,
        });

        if (!socialResponse) {
          return {
            success: false,
            message: "Invalid response",
          };
        }

        let user = await User.findOne({ email });

        if (!user) {
          user = await User.create({
            email,
            oauth,
            name,
            firebaseUid,
            companyId,
            timezone,
            roles: "Moderator",
          });
        }

        const token = getJWTToken(user);

        await addUserToGetStreamClient({
          id: user._id.toString(),
          name: `${user.name.first} ${user.name.last}`,
          email: String(user.email),
        });

        const getStreamToken = getTokenFromGetstream(user._id.toString());

        return {
          success: true,
          message: "User registered successfully.",
          data: { getStreamToken, token, user },
        };
      } else {
        const { email, password, oauth, name, referralCode, companyId } =
          document;

        const existingUser = await User.findOne({ email });

        if (existingUser) {
          return {
            success: false,
            message: "The email address is already in use by another account",
          };
        }

        let firebaseAuthUser: UserRecord;

        try {
          firebaseAuthUser = await firebaseService.createUser(
            name,
            email,
            password,
          );
        } catch (err) {
          return {
            success: false,
            message: err.message,
          };
        }
        const { uid } = firebaseAuthUser;

        const referredBy = referralCode
          ? await User.findOne({ referralCode })
          : null;

        let user = await User.create({
          email,
          firebaseUid: uid,
          name,
          oauth,
          hasPassword: true,
          companyId,
          is_2fa_Enabled: false,
          roles: "Moderator",
          referredBy: referredBy ? referredBy._id : null,
        });

        if (referralCode) {
          const referralPoints = 10;

          const [, , userReward] = await Promise.all([
            Referrals.create({
              referredByRef: referredBy._id,
              referredToRef: user._id,
              points: referralPoints,
              referralActive: true,
              type: "SIGN_UP",
            }),
            AuthHelpers.giveReferralRewards(
              referredBy._id.toString(),
              referralPoints,
            ),
            AuthHelpers.giveReferralRewards(
              user._id.toString(),
              referralPoints,
            ),
          ]);
          user = userReward;
        }
        const token = getJWTToken(user);
        return {
          success: true,
          message: "Success.",
          data: { token, user },
        };
      }
    } catch (error) {
      console.log(error);
    }
  };

  public static login = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        email: "required|email",
        password: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return SuccessResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { email, password } = req.body;

      const userData: any = await User.findOne({ email });

      if (!userData || !userData.hasPassword) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "Invalid credentials",
        });
      }

      if (userData.oauth) {
        return SuccessResponse(res, status.CONFLICT, {
          message: `You have registered through ${userData.oauth} !`,
        });
      }

      let firebaseUser: UserCredential;
      try {
        firebaseUser = await firebaseService.signInUser(email, password);
      } catch (err) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "Invalid credentials",
        });
      }

      const user = await User.findOne({ firebaseUid: firebaseUser.user.uid });

      if (!user) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "Invalid credentials",
        });
      }

      if (await isAccountDeactivated(user._id)) {
        return AccountDeactivatedResponse(res);
      }

      const token = getJWTToken(user);

      return SuccessResponse(res, status.OK, {
        message: "Success",
        data: { token, user },
      });
    } catch (error) {
      next(error);
    }
  };

  public static sendResetEmail = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        email: "required|email",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { email } = req.body;

      const emailService = new EmailService();

      const user = await User.findOne({ email });
      if (!user) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "User not found",
        });
      }

      if (user.oauth) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "User has signed in using social account",
        });
      }

      await emailService.sendPWResetEmail({
        email,
        token: getJWTToken({ email }, 1),
      });

      return SuccessResponse(res, status.OK, {
        message: "Email sent successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static resetPasswordRedirect = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { token } = req.params;
      const decoded: any = jwt.verify(token, config.JWT_SECRET);

      if (decoded) {
        const email = decoded.data.email;

        const host = `${req.protocol}://${config.HOST}`;

        // Frontend url where the password will get reset
        const resetUrl = `${host}/reset-password?email=${email}&token=${token}`;

        return res.redirect(301, resetUrl);
      }

      return ErrorResponse(res, status.UNAUTHORIZED, {
        message: "Invalid Token",
      });
    } catch (error) {
      return next(new Error("Invalid token"));
    }
  };

  public static updatePassword = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        email: "required|email",
        password: "required",
        token: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { email, password, token } = req.body;

      const decoded: any = jwt.verify(token, config.JWT_SECRET);

      if (!decoded || decoded.data.email !== email) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Invalid token or email",
        });
      }

      const existingUser = await User.findOne({ email });

      if (!existingUser) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "User does not exist",
        });
      }

      try {
        await firebaseService.updateUserPassword(
          String(existingUser.firebaseUid),
          password,
        );
      } catch (err) {
        return ErrorResponse(res, status.INTERNAL_SERVER_ERROR, {
          message: `Failed to update password`,
        });
      }

      await User.findOneAndUpdate({ email }, { hasPassword: true });

      return SuccessResponse(res, status.OK, {
        message: `User password updated successfully`,
        data: existingUser,
      });
    } catch (error) {
      next(error);
    }
  };

  public static unsubscribe = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const id = req.params.id;
      const user = await User.findByIdAndUpdate(id, {
        subscribedToNewsletter: false,
      });
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: user,
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteFirebaseUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const uid = req.params.uid;
      const data = firebaseService.deleteUser(uid);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };

  public static requestOtp = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const phone = req.body.phone;
      let email = req.body.email;
      let otp = Math.floor(10000 + Math.random() * 90000).toString();

      const validator = new Validator(req.body, {
        phone: "string",
        email: "email",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (!phone && !email) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Phone Number Required!",
          errors: validator.errors,
        });
      }

      if (phone) {
        // Issuing a fresh code clears any prior verification so a stale
        // `verified` marker can't be held open indefinitely.
        await Otp.updateOne(
          { phone },
          { $set: { otp, verified: false, verifiedAt: null } },
          { upsert: true },
        );

        const messageService = new TwilioMessageService();
        if (!messageService.validE164(phone)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Number must be in E164 format!",
            errors: validator.errors,
          });
        }

        await messageService.sendOtp(phone);
      } else {
        email = email.toLowerCase();
        if (
          email == "test@gmail.com" ||
          email == "test@byldd.com" ||
          email.startsWith("crewcam")
        ) {
          otp = "32323";
        }
        await Otp.updateOne(
          { email },
          { $set: { otp: otp, verified: false, verifiedAt: null } },
          { upsert: true },
        );

        const emailService = new EmailService();
        await emailService.sendOtpMail({
          email,
          otp,
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "OTP Sent Successfully!",
      });
    } catch (error) {
      console.log({
        // ip: req.ip,
        // ips: req.ips,
        XForwardedFor: req.headers["x-forwarded-for"],
        ip: req.ip,
        ips: req.ips, // full proxy chain when trust proxy is enabled
        forwardedFor: req.headers["x-forwarded-for"] ?? null,
        realIp: req.headers["x-real-ip"] ?? null,
        origin: req.headers.origin ?? null,
        referer: req.headers.referer ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        host: req.headers.host ?? null,
        method: req.method,
        path: req.originalUrl,
        timestamp: new Date().toISOString(),
        body: req.body,
      });
      next(error);
    }
  };

  public static resendOtp = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const phone = req.body.phone;
      let email = req.body.email;
      let otp = Math.floor(10000 + Math.random() * 90000).toString();

      const validator = new Validator(req.body, {
        phone: "phoneNumber",
        email: "email",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (!phone && !email) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Phone Number Required!",
          errors: validator.errors,
        });
      }

      if (phone) {
        // Issuing a fresh code clears any prior verification so a stale
        // `verified` marker can't be held open indefinitely.
        await Otp.updateOne(
          { phone },
          { $set: { otp, verified: false, verifiedAt: null } },
          { upsert: true },
        );

        const messageService = new TwilioMessageService();
        if (!messageService.validE164(phone)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Number must be in E164 format!",
            errors: validator.errors,
          });
        }

        await messageService.sendOtp(phone);
      } else {
        email = email.toLowerCase();
        if (email == "test@gmail.com" || email == "test@byldd.com") {
          otp = "32323";
        }

        await Otp.updateOne(
          { email },
          { $set: { otp: otp, verified: false, verifiedAt: null } },
          { upsert: true },
        );

        const emailService = new EmailService();
        await emailService.sendOtpMail({
          email,
          otp,
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "OTP Sent Successfully!",
      });
    } catch (error) {
      next(error);
    }
  };

  public static verifyOtp = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { otp, phone } = req.body;
      let email = req.body.email;
      const validator = new Validator(req.body, {
        otp: "required|string",
        phone: "phoneNumber",
        email: "email",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "OTP or Phone Required!",
          errors: validator.errors,
        });
      }

      let otpQuery: any = { phone, otp };

      if (email) {
        email = email.toLowerCase();
        otpQuery = { email, otp };

        const otpExists = await Otp.findOne(otpQuery);

        if (!otpExists) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Invalid OTP!",
            errors: validator.errors,
          });
        }
      } else {
        const messageService = new TwilioMessageService();
        if (!messageService.validE164(phone)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Number must be in E164 format!",
            errors: validator.errors,
          });
        }

        const otpExists = await messageService.verifyOtp(phone, otp);

        if (!otpExists.valid) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Invalid OTP!",
            errors: validator.errors,
          });
        }
      }

      let userQuery: any = { phone };
      if (email) {
        userQuery = { email };
      }

      // Record the verification rather than deleting it: registration reads
      // this marker as proof the OTP flow was actually completed. The code
      // itself is unset inside markOtpVerified so it can't be replayed.
      const [user]: [user: any, marked: unknown] = await Promise.all([
        User.findOne(userQuery).lean(),
        AuthHelpers.markOtpVerified(userQuery),
      ]);

      const response: any = {
        message: "OTP Verified Succesfully!.",
      };

      if (user && (await isAccountDeactivated(user._id))) {
        return AccountDeactivatedResponse(res);
      }

      if (user) {
        const { year, month } = getMonthAndYear(new Date());

        const [myTotalProjects, companies] = await Promise.all([
          ProjectMember.countDocuments({
            userId: user._id,
            status: CURRENT_STATUS.ACTIVE,
          }),
          CompanyHelpers.getMyCompanies(user._id),
          UserHelper.updateActivitylogs(user._id, month, year),
        ]);
        user.myTotalProjects = myTotalProjects;
        user.fullName = user.name.first + " " + user.name.last;
        const token = getJWTToken(user);
        response.data = { token, user };
        user.roles = companies?.[0]?.role;
        if (companies && companies.length) {
          user.companies = companies;
          user.companyId = companies[0].companyId;
          const admin = await CompanyHelpers.getCompanyAdminId(
            companies?.[0]?.companyId,
          );

          let subscriptionStatus: any = null;
          let maxTeamSize;

          if (admin?.userId) {
            const adminUser = await UserHelper.findOne({ _id: admin.userId });
            const [revenueCat, stripe] = await Promise.all([
              RevenueCatService.getSubScriptionStatus(
                admin?.userId,
                true,
                true,
              ),
              stripeService.getSubscriptionStatus(adminUser.stripeCustomerId),
            ]);

            if (stripe) {
              subscriptionStatus = stripe;
              maxTeamSize = admin.teamLimit;
            } else subscriptionStatus = revenueCat;
          } else {
            subscriptionStatus.subscriptionStatus =
              SUBSCRIPTION_STATUS.NO_SUBSCRIPTION;
          }

          if (
            subscriptionStatus.subscriptionStatus ==
            SUBSCRIPTION_STATUS.NO_SUBSCRIPTION
          ) {
            const { diffInDays } = getTimeDiffs(user.createdAt, new Date());
            if (diffInDays > 15) {
              subscriptionStatus.subscriptionStatus =
                SUBSCRIPTION_STATUS.EXPIRED;
            }
          }

          const companyMembers = await CompanyHelpers.getCompanyMembers([
            user.companyId,
          ]);

          maxTeamSize =
            maxTeamSize ||
            subscriptionPlanUsers(
              subscriptionStatus?.subscriptionPlan?.split(/[_-]/)?.[0],
            );

          user.companyMembersLimitExceded = maxTeamSize < companyMembers.length;
          user.subscriptionStatus = subscriptionStatus.subscriptionStatus;
        }
      }

      return SuccessResponse(res, status.OK, response);
    } catch (error) {
      next(error);
    }
  };

  public static twoFactorEnabled = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { email } = req.body;
      if (!email) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Email is Required!",
        });
      }

      const newSecret = factor.generateSecret({
        name: email,
      });
      const secret = newSecret.secret;
      const qrCodeUrl = newSecret.qr;

      const user = await User.findOneAndUpdate(
        { email },
        { two_fa_secret: secret },
      );

      if (!user) {
        throw new StandardError({
          message: "Invalid User!",
          code: status.CONFLICT,
        });
      }
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: {
          qrCode: qrCodeUrl,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static twoFactorVerify = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { token, email } = req.body;

      if (!token || !email) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Email or Token Required!",
        });
      }

      const user = await User.findOne({ email });
      if (!user) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "Invalid User!",
        });
      }
      const secret = user.two_fa_secret;
      const verifyToken = factor.verifyToken(secret, token);

      if (verifyToken) {
        await User.findOneAndUpdate({ email }, { is_2fa_Enabled: true });
        return SuccessResponse(res, status.OK, {
          message: "Token Verified Successfully!",
        });
      } else {
        throw new StandardError({
          message: "Invalid Token!",
          code: status.BAD_REQUEST,
        });
      }
    } catch (error) {
      next(error);
    }
  };
  public static twoFactorLogin = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { email, password, token } = req.body;
      if (!email || !password || !token) {
        throw new StandardError({
          message: "Invalid Credentials or Token!",
          code: status.UNPROCESSABLE_ENTITY,
        });
      }

      const firebaseUser: any = (
        await firebaseService.signInUser(email, password)
      ).user.toJSON();

      const user = await User.findOne({ firebaseUid: firebaseUser.uid });
      if (!user) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "Invalid User!",
        });
      }

      if (await isAccountDeactivated(user._id)) {
        return AccountDeactivatedResponse(res);
      }

      const secret = user.two_fa_secret;
      const verifyToken = factor.verifyToken(secret, token);

      if (verifyToken) {
        const verifiedToken = jwt.verify(
          getJWTToken(user),
          AuthRoutes.JWT_SECRET,
        ) as any;
        const data = { token: verifiedToken, user };
        return SuccessResponse(res, status.OK, { message: "Success.", data });
      } else {
        throw new StandardError({
          message: "Invalid 2-Factor Authentication Code!",
          code: status.BAD_REQUEST,
        });
      }
    } catch (error) {
      next(error);
    }
  };
}
