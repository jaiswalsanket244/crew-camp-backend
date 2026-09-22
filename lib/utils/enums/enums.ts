export enum ENV {
  PRODUCTION = "PRODUCTION",
  DEVELOPMENT = "DEVELOPMENT",
  TEST = "TEST",
  ENV = "ENV",
}

export const STATUS = ["ACTIVE", "INACTIVE", "DELETED"];

export enum CURRENT_STATUS {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  DELETED = "DELETED",
}

// Company membership carries an extra DEACTIVATED state: the member keeps all of
// their data and project memberships but loses access and stops counting toward
// the company's subscription seats until an admin/manager re-enables them.
export const COMPANY_MEMBER_STATUS = [
  "ACTIVE",
  "INACTIVE",
  "DELETED",
  "DEACTIVATED",
];

export enum CURRENT_COMPANY_MEMBER_STATUS {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  DELETED = "DELETED",
  DEACTIVATED = "DEACTIVATED",
}

export enum NotificationCategory {
  PROJECT_POST = "PROJECT_POST",
  MENTION = "MENTION",
  TASK_ASSIGNED = "TASK_ASSIGNED",
  TASK_COMPLETED = "TASK_COMPLETED",
  PROJECT_ADDED = "PROJECT_ADDED",
  REPORT = "REPORT",
  OTHER = "OTHER",
}

// Identifies which localized template renders a notification. Stored on the
// notification instead of the rendered sentence so the same row can be served
// in any locale. Rows without a key (e.g. reported-post notifications, whose
// body is free-form user text) fall back to the stored `message`.
export enum NotificationMessageKey {
  PROJECT_POST = "PROJECT_POST",
  COMMENT_MENTION = "COMMENT_MENTION",
  PROJECT_ADDED = "PROJECT_ADDED",
  TASK_ASSIGNED = "TASK_ASSIGNED",
  TASK_COMPLETED = "TASK_COMPLETED",
  PROFILE_UPDATED = "PROFILE_UPDATED",
  PASSWORD_CHANGED = "PASSWORD_CHANGED",
  TEST_NOTIFICATION = "TEST_NOTIFICATION",
}

export const INVITED_USER_STATUS = ["ACCEPTED", "PENDING", "CANCELED"];

export const USER_TYPE = [
  "SUPERADMIN",
  "ADMIN",
  "MANAGER",
  "STANDARD",
  "LIMITED",
  "CREW",
  "GUEST",
];

export enum USER_ROLE {
  SUPERADMIN = "SUPERADMIN",
  ADMIN = "ADMIN",
  MANAGER = "MANAGER",
  STANDARD = "STANDARD",
  LIMITED = "LIMITED",
  CREW = "CREW",
}

export const PROJECT_ACCESS = ["SUPERADMIN", "ADMIN", "MANAGER"];

// Roles allowed to markup/annotate any photo in their company (CRE-715).
// Broader than PROJECT_ACCESS by including STANDARD; still excludes LIMITED,
// CREW, and project guests.
export const PHOTO_MARKUP_ACCESS = ["SUPERADMIN", "ADMIN", "MANAGER", "STANDARD"];

// App locales a user may pick. user.language is stored as an open string, so
// adding a locale only means extending this list.
export const SUPPORTED_LANGUAGES = ["en", "es"];

export const PRODUCT_TYPE = ["REFUND", "SUBSCRIPTION"];

export const SOCIAL_AUTH_TYPE = [
  "FACEBOOK",
  "GOOGLE",
  "LINKEDIN",
  "MICROSOFT",
  "APPLE",
  "PHONE",
];

export enum SOCIAL_AUTH_TYPE_ENUM {
  PHONE = "PHONE",
  GOOGLE = "GOOGLE",
  APPLE = "APPLE",
}

export const PAYMENT_STATUS = [
  "PENDING",
  "COMPLETED",
  "FAILED",
  "PENDING_REFUND",
  "PARTIALLY_REFUNDED",
  "FULLY_REFUNDED",
];

export const REFUND_STATUS = ["PENDING", "COMPLETED", "FAILED"];

export const ROLES = {
  SUPER_ADMIN: "SUPERADMIN",
  MODERATOR: "MODERATOR",
  ADMIN: "ADMIN",
  USER: "USER",
};

export const TASK_STATUS = ["PENDING", "COMPLETED", "DELETED"];

export enum CURRENT_TASK_STATUS {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  DELETED = "DELETED",
}

export const TAGS = ["DEFAULT", "CUSTOM"];

export enum TAGS_FOR {
  POST = "POST",
  PROJECT = "PROJECT",
}

export enum CURRENT_TAGS {
  DEFAULT = "DEFAULT",
  CUSTOM = "CUSTOM",
}

export const USER_ROLES = [
  "Construction Manager",
  "Estimator",
  "Project Manager",
  "Architect",
  "Carpenter",
  "Electricial",
  "Heavy Equipment Operator",
  "Owner/leadership",
];

export const REPORT_REASONS = [
  "Inappropriate Content",
  "Spam or Misleading Content",
  "Harassment or Bullying",
  "Intellectual Property Violation",
  "Privacy Violation",
  "Violence or Threats",
  "False Information",
  "Off-Topic or Irrelevant Content",
  "Other",
];

export enum SUBSCRIPTION_STATUS {
  NO_SUBSCRIPTION = "NO_SUBSCRIPTION",
  ACTIVE = "ACTIVE",
  GRACE_PERIOD = "GRACE_PERIOD",
  EXPIRED = "EXPIRED",
}

export const SUBSCRIPTIONS = [
  "NO_SUBSCRIPTION",
  "ACTIVE",
  "GRACE_PERIOD",
  "EXPIRED",
];

export enum SUBSCRIPTION_EVENTS {
  RENEWAL = "RENEWAL",
  EXPIRATION = "EXPIRATION",
  CANCELLATION = "CANCELLATION",
  TRANSFER = "TRANSFER",
  INITIAL_PURCHASE = "INITIAL_PURCHASE",
  PRODUCT_CHANGE = "PRODUCT_CHANGE",
}

export const SUBSCRIPTION_PLANS = [
  "ultimate_pp4_419",
  "premium_pp3_224",
  "standard_pp2_89",
  "basic_pp1_39",
];

export enum SUBSCRIPTION_PURCHASE_STORE {
  STRIPE = "STRIPE",
  REVENUECAT = "REVENUECAT",
}

export const SUBSCRIPTION_STORES = ["STRIPE", "REVENUECAT"];

export enum STRIPE_SUBSCRIPTION_PLANS {
  basic = "basic",
  standard = "standard",
  premium = "premium",
  ultimate = "ultimate",
  enterprise = "enterprise",
}

export enum STRIPE_SUBSCRIPTION_PLANS_PERIOD {
  month = "month",
}

export enum SUBSCRIPTION_STORES_ENUM {
  STRIPE = "STRIPE",
  REVENUECAT = "REVENUECAT",
}

export enum MEMBER_TYPE {
  GUEST = "GUEST",
}

// Marketing attribution — source-agnostic so future ad platforms
// (Google Ads, Apple Search Ads) reuse the same values without rework.
export enum ATTRIBUTION_SOURCE {
  META = "meta",
  APPLE_SEARCH_ADS = "apple_search_ads",
  GOOGLE_ADS = "google_ads",
  ORGANIC = "organic",
  DIRECT = "direct",
}

export const ATTRIBUTION_SOURCES = [
  "meta",
  "apple_search_ads",
  "google_ads",
  "organic",
  "direct",
];

// Click id query params, one per ad platform. Stored alongside the click id as
// `click_id_type` so a stored id can always be traced back to the platform
// that issued it (and to the attribution window that platform uses).
export enum CLICK_ID_TYPE {
  FBCLID = "fbclid",
  GCLID = "gclid",
}

// How long a click id stays attributable, per source. Google's gclid window is
// materially longer than Meta's fbclid window, so the lookback MUST be
// per-source — a single global timer would drop Google conversions early.
// Sources absent from this map issue no click id, so there is nothing to age.
export const ATTRIBUTION_WINDOW_DAYS: Partial<
  Record<ATTRIBUTION_SOURCE, number>
> = {
  [ATTRIBUTION_SOURCE.META]: 7,
  [ATTRIBUTION_SOURCE.GOOGLE_ADS]: 90,
};

// Source a click id belongs to, keyed by its `click_id_type`.
export const CLICK_ID_TYPE_SOURCE: Record<CLICK_ID_TYPE, ATTRIBUTION_SOURCE> = {
  [CLICK_ID_TYPE.FBCLID]: ATTRIBUTION_SOURCE.META,
  [CLICK_ID_TYPE.GCLID]: ATTRIBUTION_SOURCE.GOOGLE_ADS,
};

// Raw revenue facts captured from payment providers so CAC/LTV can be
// calculated later. Provider-agnostic so non-Stripe channels reuse the shape.
export enum REVENUE_EVENT_TYPE {
  TRIAL_START = "trial_start",
  SUBSCRIPTION_CREATED = "subscription_created",
  RENEWAL = "renewal",
  UPGRADE = "upgrade",
}

export const REVENUE_EVENT_TYPES = [
  "trial_start",
  "subscription_created",
  "renewal",
  "upgrade",
];

export enum PAYMENT_PROVIDER {
  STRIPE = "stripe",
}

export enum PAYMENT_CHANNEL {
  STRIPE_WEB = "stripe_web",
}
