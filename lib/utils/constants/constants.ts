import { STRIPE_SUBSCRIPTION_PLANS } from "../enums/enums";

export const APP_CONST = {
  PRICES: {
    SUB_AMOUNT: 2000,
  },
};

export const CONTACT_US_URL = "https://www.relaycam.com/contact";

// Hard cap on per-user project pins. Load-bearing for the projects.list read path: pinned rows
// are fetched and spliced ahead of the paged query, so a bounded pin set keeps that extra fetch
// cheap and confines the offset shift to the first page or two.
export const MAX_PINS_PER_USER = 100;

export const ACCOUNT_DEACTIVATED_MESSAGE =
  "Your account has been deactivated. Please contact your manager to re-enable it.";

// Machine-readable marker returned alongside ACCOUNT_DEACTIVATED_MESSAGE so
// clients can route to the deactivated screen instead of matching on copy.
export const ACCOUNT_DEACTIVATED_CODE = "ACCOUNT_DEACTIVATED";

export const subscriptionPlanUsers = (subscriptionPlan: string) => {
  let users = 2;
  switch (subscriptionPlan) {
    case STRIPE_SUBSCRIPTION_PLANS.basic:
      users = 2;
      break;
    case STRIPE_SUBSCRIPTION_PLANS.standard:
      users = 5;
      break;
    case STRIPE_SUBSCRIPTION_PLANS.premium:
      users = 15;
      break;
    case STRIPE_SUBSCRIPTION_PLANS.ultimate:
      users = 30;
      break;
    case STRIPE_SUBSCRIPTION_PLANS.enterprise:
      users = 10000;
      break;
    default:
      users = 2;
      break;
  }

  return users;
};

export const REDIS_GRID_POSTS_CACHE_COMPANY_IDS: string[] = [
  // seth's company
  "698e4380b026b730c65bedc7",
  //aditya's staging company
  "672dad0a978c51b5ce085183",
  //aditya's production company,
  "6729ee4bb2c477e5aa428cc0",
  //debra's company
  "6a0636f724a64f88f05e050f",
];

// Companies where every active company member is auto-added to projects created
// by an inbound CRM sync (JobNimbus/CompanyCam webhooks).
export const CRM_SYNC_AUTO_JOIN_ALL_MEMBERS_COMPANY_IDS: string[] = [
  // seth's company
  "698e4380b026b730c65bedc7",
];

export const FILES_STORAGE_LIMIT = 5 * 1024 * 1024; // 2 GB since we store in kb

// Retention for everything in a trash bin — posts, tasks, checklists, reports,
// files and whole projects. One window for all of them by design.
export const TRASHBIN_NO_OF_DAYS = 30;

export const MAX_S3_PARTS = 10000;
export const MIN_CHUNK_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024 * 1024;

export const S3_PART_ETAG_REGEX = /^"[a-zA-Z0-9_-]{8,}"$/;

export const MULTIPART_PART_URL_TTL_SECONDS = 15 * 60;

export const MAX_PARALLEL_PRESIGNS = 32;

// Search config that used to be env vars — now code constants (removed from .env / Infisical).
// OpenSearch cluster region — us-east-1 across all environments.
export const OPENSEARCH_REGION = "us-east-1";
// Baseline latency metrics (Story 1.6) — "true" enables Mongo baseline-latency capture.
export const ENABLE_BASELINE_METRICS = "false";

// How long an OTP verification stays usable as proof of a real signup. Long
// enough to cover filling out the rest of the signup form, short enough that a
// harvested verification isn't reusable later.
export const SIGNUP_VERIFICATION_WINDOW_MINUTES = 30;

// Browser origins for our first-party web apps. Single source of truth shared by
// the CORS allowlist and the Turnstile middleware (which only enforces on web traffic).
export const WEB_APP_ORIGINS: string[] = [
  "https://staging.crewcamapp.com",
  "https://web.crewcamapp.com",
  "https://app.crewcamapp.com",
  "https://superadmin.crewcamapp.com",
  "https://staging.relaycam.com",
  "https://web.relaycam.com",
  "https://app.relaycam.com",
  "https://superadmin.relaycam.com",
  "http://localhost:3000", // For local development
  "http://localhost:3001", // Alternative local port
];
