import {
  ATTRIBUTION_SOURCE,
  ATTRIBUTION_WINDOW_DAYS,
  CLICK_ID_TYPE,
  CLICK_ID_TYPE_SOURCE,
} from "../enums/enums";
import { IAttribution } from "../interfaces/attribution";

// String-valued attribution fields (everything except attribution_captured_at).
type AttributionStringField = Exclude<
  keyof IAttribution,
  "attribution_captured_at"
>;

// Whitelisted string fields copied verbatim from the signup payload. Kept as a
// list so the set of stored fields is explicit and safe from arbitrary input.
const STRING_FIELDS: AttributionStringField[] = [
  "click_id",
  "click_id_type",
  "campaign_id",
  "campaign_name",
  "landing_page_url",
  "referrer_url",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbp",
  "fbc",
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve which platform a click id came from using its `click_id_type`.
 *
 * Falls back to Meta for a click id sent without a recognizable type: fbclid
 * was the only click id any shipped client sent before Google Ads, so an
 * untyped id is historically an fbclid.
 */
const inferSourceFromClickId = (
  attribution: IAttribution,
): ATTRIBUTION_SOURCE => {
  if (!attribution.click_id) return ATTRIBUTION_SOURCE.ORGANIC;

  const clickIdType = attribution.click_id_type;
  if (clickIdType && clickIdType in CLICK_ID_TYPE_SOURCE) {
    return CLICK_ID_TYPE_SOURCE[clickIdType as CLICK_ID_TYPE];
  }
  return ATTRIBUTION_SOURCE.META;
};

/**
 * Drop a click id that has aged out of its platform's attribution window.
 *
 * The window is per-source (see ATTRIBUTION_WINDOW_DAYS) because Google's
 * ~90-day gclid window is far longer than Meta's 7-day fbclid window; a single
 * global timer would expire Google conversions while they are still valid.
 *
 * An expired click is downgraded to `organic` and loses `click_id`,
 * `click_id_type` and `fbc` (which embeds the fbclid, so keeping it would keep
 * the click id under another name). UTMs, landing page, referrer, `fbp` and the
 * capture timestamp are raw facts and are always kept, so reporting can still
 * see where the visit came from even when the click is no longer attributable.
 *
 * A click id with no capture timestamp cannot be aged, so it is kept rather
 * than discarded on a missing field.
 */
const expireStaleClickId = (attribution: IAttribution): void => {
  const source = attribution.source as ATTRIBUTION_SOURCE;
  const windowDays = ATTRIBUTION_WINDOW_DAYS[source];

  if (!attribution.click_id || !windowDays) return;
  if (!attribution.attribution_captured_at) return;

  const ageMs = Date.now() - attribution.attribution_captured_at.getTime();
  if (ageMs <= windowDays * MS_PER_DAY) return;

  delete attribution.click_id;
  delete attribution.click_id_type;
  delete attribution.fbc;
  attribution.source = ATTRIBUTION_SOURCE.ORGANIC;
};

/**
 * Normalize the raw `attribution` object from a signup request into the shape
 * stored on the user document.
 *
 * - Copies only whitelisted string fields.
 * - Parses `attribution_captured_at` (the original ad-click time) into a Date.
 * - Infers `source` from the click id type when the payload omits it.
 * - Expires a click id that is older than its platform's attribution window.
 * - Defaults `source` to 'organic' when no source and no ad click id are
 *   present, so organic/direct signups never crash on missing attribution.
 *
 * Always returns an object with at least `source` set, so every signup records
 * an attribution fact even when the payload is empty.
 */
export const buildAttribution = (raw: unknown): IAttribution => {
  const input = (raw ?? {}) as Record<string, unknown>;
  const result: IAttribution = {};

  for (const field of STRING_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim() !== "") {
      result[field] = value.trim();
    }
  }

  const source = input.source;
  if (typeof source === "string" && source.trim() !== "") {
    result.source = source.trim();
  }

  const capturedAt = input.attribution_captured_at;
  if (typeof capturedAt === "string" || typeof capturedAt === "number") {
    const parsed = new Date(capturedAt);
    if (!isNaN(parsed.getTime())) {
      result.attribution_captured_at = parsed;
    }
  } else if (capturedAt instanceof Date && !isNaN(capturedAt.getTime())) {
    result.attribution_captured_at = capturedAt;
  }

  // No explicit source: infer the platform from the click id type, otherwise
  // treat as organic so no-attribution signups never produce a null source.
  if (!result.source) {
    result.source = inferSourceFromClickId(result);
  }

  // Server-side enforcement of the per-source window. The client applies the
  // same rule before sending, but the stored click id lives in browser storage
  // the client controls, and mobile clients will post the same payload later.
  expireStaleClickId(result);

  return result;
};
