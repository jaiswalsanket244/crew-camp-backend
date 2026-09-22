export enum LEAD_SOURCE {
  APP_DOWNLOAD = "App Download",
}

export const SALESFORCE_API_VERSION = "v62.0";

/**
 * Salesforce errors meaning a stored lead Id no longer points at a live,
 * writable record. The sync clears the stored Id on these so the next run
 * re-resolves the lead by email (or recreates it) instead of failing forever.
 *
 * A converted lead is deliberately excluded — that's a real record the sales
 * team turned into a Contact, so the sync re-routes the write to that Contact
 * instead of replacing the lead with a fresh duplicate.
 */
export const SALESFORCE_STALE_ID_ERRORS: string[] = [
  "ENTITY_IS_DELETED",
  "NOT_FOUND",
  "INVALID_CROSS_REFERENCE_KEY",
  "MALFORMED_ID",
];

/**
 * Salesforce rejects every write to a lead the sales team converted, and no API
 * flag overrides it. Seeing this code means the snapshot has to be pushed onto
 * the Contact the lead became.
 */
export const SALESFORCE_CONVERTED_LEAD_ERROR = "CANNOT_UPDATE_CONVERTED_LEAD";

/** Hard cap enforced by the Salesforce composite sObject collections API. */
export const SALESFORCE_COMPOSITE_BATCH_SIZE = 200;

/**
 * Records per write request. At one, a rejected record can only ever fail itself:
 * Salesforce throws out an entire collection with a 400 when any single record in
 * it is malformed, and a one-record collection has no bystanders to take down.
 *
 * The cost is one API call per account instead of one per 200 — a full run of
 * ~3.7k accounts against a 100k daily request limit. Raise it back toward 200 to
 * trade that quota back for the batch-level blast radius; the write path splits a
 * rejected batch in halves either way, so both sizes stay correct.
 */
export const SALESFORCE_PUSH_BATCH_SIZE = 100;

/**
 * The JWT bearer flow doesn't return `expires_in`, so tokens are cached for a
 * conservative window well under the default 2h org session timeout. A 401 also
 * forces a refresh, so this only controls how often we re-mint on the happy path.
 */
export const SALESFORCE_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Accounts with no subscription go to EXPIRED after this trial window. */
export const TRIAL_PERIOD_DAYS = 15;
