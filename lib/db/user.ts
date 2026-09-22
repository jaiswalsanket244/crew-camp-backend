import * as mongoose from "mongoose";
import { ObjectId, generateReferralCode } from "../utils/helpers/commonHelper";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../utils/interfaces/notificationPreferences";
import {
  ATTRIBUTION_SOURCES,
  SOCIAL_AUTH_TYPE,
  SUBSCRIPTIONS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STORES,
  USER_TYPE,
} from "../utils/enums/enums";

export interface IUser {
  email: string;
  password: string;
  name: string;
  get: (path: string) => any;
  set: (path: string, value: any) => any;
  profile: any;
  firstName: string;
  roles: string[];
  oauth: [string];
  otp: string;
  token: string;
  qrCode: string;
  lastActivity?: string;
  language?: string;
}

export const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: function () {
        return !this.phone;
      },
    },
    name: {
      first: {
        type: String,
        required: function () {
          return !this.phone;
        },
      },
      last: {
        type: String,
        required: function () {
          return !this.phone;
        },
      },
    },
    phone: {
      type: String,
      required: function () {
        return !this.email;
      },
    },
    firebaseUid: {
      type: String,
      required: function () {
        return !this.phone;
      },
    },
    two_fa_secret: {
      type: String,
      required: false,
    },
    is_2fa_Enabled: {
      type: Boolean,
      default: false,
    },
    oauth: [
      {
        type: String,
        enum: SOCIAL_AUTH_TYPE,
        required: false,
      },
    ],
    userRole: {
      type: String,
      required: false,
    },
    roles: {
      type: String,
      enum: USER_TYPE,
      default: "STANDARD",
    },
    profileImage: {
      type: String,
      required: false,
    },
    stripeCustomerId: {
      type: String,
    },
    stripeAccountId: {
      type: String,
      required: false,
    },
    defaultCardToken: {
      type: String,
    },
    cardTokens: [String],
    renewalDate: {
      type: Date,
      required: false,
    },
    subscribedOn: {
      type: Number,
      required: false,
    },
    subscriptionActiveUntil: {
      type: Date,
    },
    subscriptionId: {
      type: String,
      required: false,
    },
    subscriptionCancellationRequested: {
      type: Boolean,
      default: false,
    },
    referralCode: {
      type: String,
      unique: true,
    },
    referredBy: {
      type: ObjectId,
      ref: "User",
      required: false,
    },
    referralRewards: {
      type: Number,
      default: 0,
    },
    subscriptionRef: {
      type: ObjectId,
      ref: "Subscription",
      required: false,
    },
    subscriptionStatus: {
      type: String,
      enum: SUBSCRIPTIONS,
      required: false,
      default: SUBSCRIPTION_STATUS.NO_SUBSCRIPTION,
    },
    subscriptionBoughtFrom: {
      type: String,
      enum: SUBSCRIPTION_STORES,
      required: false,
    },
    subscriptionPlan: {
      type: String,
      required: false,
    },
    companyName: {
      type: String,
      required: false,
    },
    companyRef: {
      type: String,
      required: false,
    },
    addTimeStampToImages: {
      type: Boolean,
      default: true,
    },
    // App display language (e.g. "en", "es"), validated against
    // SUPPORTED_LANGUAGES at the route level. Unset = follow device language.
    language: {
      type: String,
      required: false,
    },
    notificationPreferences: {
      channels: {
        push: {
          type: Boolean,
          default: DEFAULT_NOTIFICATION_PREFERENCES.channels.push,
        },
        inApp: {
          type: Boolean,
          default: DEFAULT_NOTIFICATION_PREFERENCES.channels.inApp,
        },
      },
      types: {
        projectPosts: {
          type: Boolean,
          default: DEFAULT_NOTIFICATION_PREFERENCES.types.projectPosts,
        },
        mentions: {
          type: Boolean,
          default: DEFAULT_NOTIFICATION_PREFERENCES.types.mentions,
        },
        tasks: {
          type: Boolean,
          default: DEFAULT_NOTIFICATION_PREFERENCES.types.tasks,
        },
        addedToProject: {
          type: Boolean,
          default: DEFAULT_NOTIFICATION_PREFERENCES.types.addedToProject,
        },
      },
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    // Salesforce Lead record Id, captured when the lead is created. Lets the
    // nightly account sync update the lead directly instead of looking it up.
    salesforceLeadId: {
      type: String,
      required: false,
    },
    // Contact the lead was converted into. Salesforce blocks all writes to a
    // converted lead, so once this is set the sync pushes here instead.
    salesforceContactId: {
      type: String,
      required: false,
    },
    // Marketing attribution captured from the signup payload. Source-agnostic
    // so Google Ads / Apple Search Ads reuse the same fields later. All fields
    // are optional — organic/direct signups simply omit the ad-specific ones.
    attribution: {
      // 'meta' | 'apple_search_ads' | 'google_ads' | 'organic' | 'direct'
      source: { type: String, enum: ATTRIBUTION_SOURCES, required: false },
      click_id: { type: String, required: false }, // fbclid for meta
      click_id_type: { type: String, required: false }, // e.g. 'fbclid'
      campaign_id: { type: String, required: false },
      campaign_name: { type: String, required: false },
      landing_page_url: { type: String, required: false },
      referrer_url: { type: String, required: false },
      utm_source: { type: String, required: false },
      utm_medium: { type: String, required: false },
      utm_campaign: { type: String, required: false },
      utm_content: { type: String, required: false },
      utm_term: { type: String, required: false },
      fbp: { type: String, required: false }, // Meta browser pixel cookie
      fbc: { type: String, required: false }, // Meta click cookie
      // Time of the original ad click, NOT the signup time.
      attribution_captured_at: { type: Date, required: false },
    },
  },
  {
    timestamps: true,
    toObject: {
      virtuals: true,
    },
    toJSON: {
      virtuals: true,
    },
  },
);

UserSchema.pre<IUser>("save", function (next: any): void {
  const email = this.get("profile.email");
  if (email) {
    this.profile.email = this.profile.email.toLowerCase();
  }

  const firstName = this.firstName;
  if (firstName) {
    this.set("profile.name.first", firstName.trim());
  }

  const lastName = this.get("profile.name.last");
  if (lastName) {
    this.set("profile.name.last", lastName.trim());
  }
  if (this.roles.length === 0) {
    this.roles.push("user");
  }

  next();
});

UserSchema.virtual("fullName").get(function (): string {
  return `${this.name.first} ${this.name.last}`;
});

UserSchema.virtual("isSuperAdmin").get(function (): boolean {
  return this.roles.includes("Super Admin");
});

UserSchema.virtual("isAdmin").get(function (): boolean {
  return this.roles.includes("Admin");
});

UserSchema.index({
  email: "text",
  "name.first": "text",
  "name.last": "text",
});

// Generate a referral code for a new user

UserSchema.pre<any>("save", async function (next: any): Promise<void> {
  if (!this.referralCode) {
    // Generate a unique referral code
    this.referralCode = await generateReferralCode();
  }
  next();
});
