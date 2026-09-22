import * as dayjs from "dayjs";
import * as utc from "dayjs/plugin/utc";

dayjs.extend(utc);

// Anything callers already hold for a timestamp: an ISO/parseable string, an
// epoch-ms number, a Date, or a nullish/absent value.
export type DateInput = string | number | Date | null | undefined;

// Canonical "last updated" display format, matching the web client's
// "MMM D, YYYY" (e.g. "Sep 22, 2026"). Kept as the default so the API renders
// timestamps the same way the web client does.
export const DISPLAY_DATE_FORMAT = "MMM D, YYYY";

// Parse in UTC so output is deterministic regardless of the server's local
// timezone; a bare date string ("2026-09-22") is read as that UTC calendar day.
const parseUtc = (input: Exclude<DateInput, null | undefined | "">) =>
  dayjs.utc(input);

/**
 * Format a timestamp into a canonical display string (default "MMM D, YYYY").
 *
 * Returns "" for empty/nullish or unparseable input so callers can drop it
 * straight into a response without a null check. Pure — no wall-clock reads,
 * no I/O.
 */
export const formatDisplayDate = (
  input: DateInput,
  format: string = DISPLAY_DATE_FORMAT,
): string => {
  if (input === null || input === undefined || input === "") return "";
  const parsed = parseUtc(input);
  return parsed.isValid() ? parsed.format(format) : "";
};

/**
 * Normalise a timestamp to a canonical UTC ISO-8601 string, or null when the
 * input is empty/nullish or unparseable. Useful for storing/comparing a single
 * canonical form before formatting for display.
 */
export const toIsoString = (input: DateInput): string | null => {
  if (input === null || input === undefined || input === "") return null;
  const parsed = parseUtc(input);
  return parsed.isValid() ? parsed.toISOString() : null;
};
