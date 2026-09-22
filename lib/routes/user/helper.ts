import {
  ProjectMember,
  ProjectPin,
  User,
  CompanyMember,
  Project,
  Tags,
  Posts,
  ProjectTasks,
  Comments,
  Company,
  ProjectNotes,
  Report,
  Likes,
  Notification,
  FcmTokens,
  ActivityLogs,
  InvitedUsers,
  CrewsMembers,
  UserSettings,
  ContactChangeOtp,
  ContactChangeReauth,
  Otp,
} from "../../db";
import { Types } from "mongoose";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { SUBSCRIPTION_STATUS } from "../../utils/enums/enums";
import { CONTACT_CHANGE_TYPE } from "../../utils/enums/contactChange";
import { invalidatePostsUploadsCache } from "../../services/redis/postCache";
import { defaultUserSettings } from "../../utils/constants/user";
import { IUserSettings } from "../../utils/interfaces/user";

type mongoId = Types.ObjectId;
export class UserHelper {
  public static create = (userData: any) => {
    return User.create(userData);
  };

  public static deleteUserProfile = (userId: mongoId) => {
    return User.findByIdAndDelete(userId);
  };

  public static deleteMultipleUserprofiles = (userIds: mongoId[]) => {
    return User.deleteMany({ _id: { $in: userIds } });
  };

  public static deleteUserCompanyProfile = (userId: mongoId) => {
    return CompanyMember.deleteMany({ userId });
  };
  public static deleteUserProjectProfile = (userId: mongoId) => {
    return ProjectMember.deleteMany({ userId });
  };

  public static deleteCompany = (companyId: mongoId) => {
    return Company.findByIdAndDelete(companyId);
  };

  public static deleteInvites = (companyId: mongoId) => {
    return InvitedUsers.deleteMany({ companyId });
  };

  public static removeCompanyMembers = (companyId: mongoId) => {
    return CompanyMember.deleteMany({ companyId });
  };

  public static removeProjects = (companyId: mongoId) => {
    return Project.deleteMany({ companyId });
  };

  public static removeCompanyTags = (companyId: mongoId) => {
    return Tags.deleteMany({ companyId });
  };

  public static removeProjectMembers = (projectIds: mongoId[]) => {
    return ProjectMember.deleteMany({ projectId: { $in: projectIds } });
  };

  // Per-user pins are a separate collection, so company/project deletion has to clear them
  // explicitly or they linger and keep counting against MAX_PINS_PER_USER.
  public static removeProjectPins = (projectIds: mongoId[]) => {
    return ProjectPin.deleteMany({ projectId: { $in: projectIds } });
  };

  public static getPostIds = (projectIds: mongoId[]) => {
    return Posts.find({ projectId: { $in: projectIds } }, { _id: 1 });
  };

  public static deletePosts = async (projectIds: mongoId[]) => {
    const filter = { projectId: { $in: projectIds } };
    const companyIds = await Posts.distinct("companyId", filter);
    const result = await Posts.deleteMany(filter);
    // Await so callers don't return before allowlisted companies' caches are
    // refreshed; non-allowlisted companies short-circuit in O(1).
    await Promise.all(
      companyIds.map((id) => invalidatePostsUploadsCache(id as ObjectIdType)),
    );
    return result;
  };

  public static deleteProjectTasks = (projectIds: mongoId[]) => {
    return ProjectTasks.deleteMany({ projectId: { $in: projectIds } });
  };

  public static getProjectNoteIds = (projectIds: mongoId[]) => {
    return ProjectNotes.find({ projectId: { $in: projectIds } }, { _id: 1 });
  };

  public static deleteProjectNotes = (projectIds: mongoId[]) => {
    return Posts.deleteMany({ projectId: { $in: projectIds } });
  };

  public static deleteReports = (postIds: mongoId[]) => {
    return Report.deleteMany({ postId: { $in: postIds } });
  };

  public static getCommentIds = (
    projectIds: mongoId[],
    postIds: mongoId[],
    projectNoteIds: mongoId[],
  ) => {
    return Promise.all([
      Comments.find({ projectId: { $in: projectIds } }, { _id: 1 }),
      Comments.find({ postId: { $in: postIds } }, { _id: 1 }),
      Comments.find({ projectNoteId: { $in: projectNoteIds } }, { _id: 1 }),
    ]);
  };

  public static getReplys = (commentIds: mongoId[]) => {
    return Comments.find({ commentId: { $in: commentIds } }, { _id: 1 });
  };

  public static lastActive = async (userId: ObjectIdType) => {
    return User.findByIdAndUpdate(userId, {
      lastActivity: Date.now(),
    });
  };

  public static removeComments = (
    projectIds: mongoId[],
    postIds: mongoId[],
    projectNoteIds: mongoId[],
    commentIds: mongoId[],
  ) => {
    return Promise.all([
      Comments.deleteMany({ projectId: { $in: projectIds } }),
      Comments.deleteMany({ postId: { $in: postIds } }),
      Comments.deleteMany({ projectNoteId: { $in: projectNoteIds } }),
      Comments.deleteMany({ commentId: { $in: commentIds } }),
    ]);
  };

  public static deleteLikes = (
    commentIds: mongoId[],
    projectNoteIds: mongoId[],
  ) => {
    return Promise.all([
      Likes.deleteMany({ commentId: { $in: commentIds } }),
      Likes.deleteMany({ noteId: { $in: projectNoteIds } }),
    ]);
  };

  public static deleteNotifications = (userIds: mongoId[]) => {
    return Notification.deleteMany({ userId: { $in: userIds } });
  };

  public static deleteFcmToken = (userId: mongoId) => {
    return FcmTokens.deleteMany({ userId });
  };

  public static updateActivitylogs = (
    userId: Types.ObjectId,
    month: number,
    year: number,
  ) => {
    return ActivityLogs.findOneAndUpdate(
      {
        userId,
        month,
        year,
      },
      { updatedAt: new Date() },
      { upsert: true },
    );
  };

  public static findOne = (query: any) => {
    return User.findOne(query).lean();
  };

  public static findByIdAndUpdate = (userId: any, update: any) => {
    return User.findByIdAndUpdate(userId, { $set: update }, { new: true });
  };

  public static getUsersFireBaseId = (userIds: ObjectIdType[]) => {
    return User.find({ _id: { $in: userIds } }, { firebaseUid: 1 });
  };

  public static clearUserDataExceptNameAndImage = (userId: mongoId) => {
    return User.findByIdAndUpdate(
      userId,
      {
        $unset: {
          email: "",
          phone: "",
          firebaseUid: "",
          two_fa_secret: "",
          userRole: "",
          stripeCustomerId: "",
          stripeAccountId: "",
          defaultCardToken: "",
          renewalDate: "",
          subscribedOn: "",
          subscriptionActiveUntil: "",
          subscriptionId: "",
          referredBy: "",
          subscriptionRef: "",
          subscriptionBoughtFrom: "",
          subscriptionPlan: "",
          companyRef: "",
        },
        $set: {
          oauth: [],
          cardTokens: [],
          is_2fa_Enabled: false,
          subscriptionCancellationRequested: false,
          referralRewards: 0,
          addTimeStampToImages: true,
          lastActivity: new Date(),
        },
      },
      { new: true },
    );
  };

  public static addStaticUser = (payload: any) => {
    return User.create(payload);
  };

  public static removeUserFromCrews = (userId: mongoId) => {
    return CrewsMembers.deleteMany({ userId });
  };

  public static isAdminSubscriptionActive = async (userId: mongoId) => {
    const admin = await User.findById(userId).select("subscriptionStatus");

    return (
      admin?.subscriptionStatus &&
      admin.subscriptionStatus == SUBSCRIPTION_STATUS.ACTIVE
    );
  };

  public static getUserSettings = async (userId: mongoId) => {
    const user = await UserSettings.findOne({ userId }).lean();
    if (!user) {
      return defaultUserSettings;
    }
    return user;
  };

  public static updateUsersSettings = (
    userId: mongoId,
    userSettings: IUserSettings,
  ) => {
    return UserSettings.findByIdAndUpdate(
      userId,
      { $set: userSettings },
      { upsert: true },
    );
  };

  // --- Self-serve email/phone change (CRE-438) ---

  // Is this email/phone already used by a DIFFERENT user? Enforces uniqueness
  // (there is no DB unique index on email/phone yet). Email is matched
  // case-insensitively because older signup paths did not lowercase it, so a
  // mixed-case duplicate (e.g. "Foo@X.com") must still be detected.
  public static isContactInUse = (
    type: CONTACT_CHANGE_TYPE,
    value: string,
    excludeUserId: mongoId | string,
  ) => {
    const query: Record<string, unknown> = {
      [type]: value,
      _id: { $ne: excludeUserId },
    };
    return type === CONTACT_CHANGE_TYPE.EMAIL
      ? User.findOne(query).collation({ locale: "en", strength: 2 }).lean()
      : User.findOne(query).lean();
  };

  // Atomically claims the resend slot for (userId, type) and stores the new OTP.
  // The filter only matches a doc older than the cooldown cutoff, so:
  //  - no doc / stale doc -> upsert refreshes or inserts and returns the doc;
  //  - fresh doc (cooldown active) -> filter misses, upsert tries to INSERT, the
  //    unique {userId,type} index throws E11000, and we return null so the caller
  //    responds with the cooldown 429. This makes the resend throttle race-proof
  //    (Mongo error-code knowledge stays here, not in the route).
  public static claimContactChangeSlot = async (params: {
    userId: mongoId | string;
    type: CONTACT_CHANGE_TYPE;
    newValue: string;
    otp: string;
    expiresAt: Date;
    cooldownCutoff: Date;
  }) => {
    const { userId, type, newValue, otp, expiresAt, cooldownCutoff } = params;
    try {
      return await ContactChangeOtp.findOneAndUpdate(
        { userId, type, updatedAt: { $lte: cooldownCutoff } },
        { $set: { newValue, otp, expiresAt, attempts: 0 } },
        { new: true, upsert: true },
      );
    } catch (error) {
      if (error?.code === 11000) return null;
      throw error;
    }
  };

  // Single-winner gate: atomically removes and returns the pending change ONLY if
  // it still matches the exact otp+value being committed. Pinning to otp/newValue
  // means a concurrent re-request that replaced the doc can't be consumed here, so
  // verify can't commit a superseded value (closes the register->consume TOCTOU).
  public static consumePendingContactChange = (
    userId: mongoId | string,
    type: CONTACT_CHANGE_TYPE,
    otp: string,
    newValue: string,
  ) => {
    return ContactChangeOtp.findOneAndDelete({ userId, type, otp, newValue });
  };

  // Atomically counts this verify attempt and returns the updated pending doc (or
  // null if none). timestamps:false so the $inc does NOT bump updatedAt — that
  // field is the resend-cooldown clock and must track the last SEND, not the last
  // guess (otherwise a wrong guess re-arms the cooldown).
  public static registerContactChangeAttempt = (
    userId: mongoId | string,
    type: CONTACT_CHANGE_TYPE,
  ) => {
    return ContactChangeOtp.findOneAndUpdate(
      { userId, type },
      { $inc: { attempts: 1 } },
      { new: true, timestamps: false },
    );
  };

  // Scoped delete for the send-failure rollback: removes only the doc THIS request
  // just claimed (matched by otp), so a slow-then-failed send can't wipe a newer
  // claim that legitimately refreshed the slot after the cooldown.
  public static discardClaimedContactChange = (
    userId: mongoId | string,
    type: CONTACT_CHANGE_TYPE,
    otp: string,
  ) => {
    return ContactChangeOtp.deleteOne({ userId, type, otp });
  };

  public static findByFirebaseUid = (firebaseUid: string) => {
    return User.findOne({ firebaseUid }).lean();
  };

  public static claimReauthSlot = async (params: {
    userId: mongoId | string;
    channel: CONTACT_CHANGE_TYPE;
    otp: string;
    expiresAt: Date;
    cooldownCutoff: Date;
  }) => {
    const { userId, channel, otp, expiresAt, cooldownCutoff } = params;
    try {
      return await ContactChangeReauth.findOneAndUpdate(
        { userId, updatedAt: { $lte: cooldownCutoff } },
        {
          $set: { channel, otp, expiresAt, attempts: 0 },
          $unset: { verifiedAt: 1 },
        },
        { new: true, upsert: true },
      );
    } catch (error) {
      if (error?.code === 11000) return null;
      throw error;
    }
  };

  // Scoped delete for the send-failure rollback (matched by otp so a newer
  // claim is never clobbered).
  public static discardClaimedReauth = (
    userId: mongoId | string,
    otp: string,
  ) => {
    return ContactChangeReauth.deleteOne({ userId, otp });
  };

  // Atomically counts a reauth verify attempt (timestamps:false so the resend
  // cooldown clock keeps tracking the last SEND, not the last guess).
  public static registerReauthAttempt = (userId: mongoId | string) => {
    return ContactChangeReauth.findOneAndUpdate(
      { userId },
      { $inc: { attempts: 1 } },
      { new: true, timestamps: false },
    );
  };

  // Converts the doc into an active grant (or creates one for the phone
  // channel, which never stores an OTP).
  public static upsertReauthGrant = (
    userId: mongoId | string,
    channel: CONTACT_CHANGE_TYPE,
    expiresAt: Date,
  ) => {
    return ContactChangeReauth.findOneAndUpdate(
      { userId },
      {
        $set: { channel, verifiedAt: new Date(), expiresAt },
        $unset: { otp: 1 },
      },
      { new: true, upsert: true },
    );
  };

  public static getActiveReauthGrant = (userId: mongoId | string) => {
    return ContactChangeReauth.findOne({
      userId,
      verifiedAt: { $ne: null },
      expiresAt: { $gt: new Date() },
    }).lean();
  };

  // A grant is single-use: consumed once a change commits.
  public static consumeReauthGrant = (userId: mongoId | string) => {
    return ContactChangeReauth.deleteOne({ userId });
  };

  public static updateUserContactField = (
    userId: mongoId | string,
    type: CONTACT_CHANGE_TYPE,
    value: string,
  ) => {
    return User.findByIdAndUpdate(
      userId,
      { $set: { [type]: value } },
      { new: true },
    );
  };

  // Clears stale login OTPs keyed by the given email/phone value.
  public static deleteLoginOtps = (
    type: CONTACT_CHANGE_TYPE,
    value: string,
  ) => {
    return Otp.deleteMany({ [type]: value });
  };
}
