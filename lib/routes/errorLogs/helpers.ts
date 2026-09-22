import { FilterQuery } from "mongoose";
import { ErrorLogs } from "../../db";
import {
  ErrorLogsQueryParams,
  ErrorLogResponseRecord,
} from "../../utils/interfaces/errorLogs";

// Human-friendly labels for the raw errorType values. Keeps the API response
// readable for non-engineers.
const EVENT_LABELS: Record<string, { label: string; category: string }> = {
  DB_DISCONNECTED: { label: "Connection Dropped", category: "Connection" },
  DB_CONNECTION_ERROR: { label: "Connection Error", category: "Connection" },
  DB_RECONNECTED: { label: "Connection Restored", category: "Connection" },
  DB_CONNECT_ATTEMPT_FAILED: {
    label: "Startup Retry Failed",
    category: "Startup",
  },
  DB_HEALTH_CHECK_ERROR: { label: "Health Check Error", category: "Internal" },
  DB_FLUSH_FAILED: { label: "Log Save Failed", category: "Internal" },
  DB_OPPORTUNISTIC_FLUSH_FAILED: {
    label: "Proactive Save Failed",
    category: "Internal",
  },
  DB_RESTORE_FAILED: { label: "Disk Restore Failed", category: "Internal" },
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_PAGE = 1;

export class ErrorLogsHelpers {
  // Maps an errorType to a friendly label + category. Falls back gracefully
  // for any unknown type.
  public static describe(eventType: string): {
    label: string;
    category: string;
  } {
    return (
      EVENT_LABELS[eventType] || {
        label: eventType
          .replace(/^DB_/, "")
          .toLowerCase()
          .replace(/_/g, " ")
          .replace(/^./, (c) => c.toUpperCase()),
        category: "Other",
      }
    );
  }

  // Parses a date string. Date-only strings (YYYY-MM-DD) expand to start or
  // end of day in the requested timezone (default UTC) so `from=2026-06-10`
  // with `timezone=Asia/Kolkata` means "start of June 10 India time".
  // Full ISO strings (with T) are used as-is — the caller embedded the offset.
  public static parseDate(
    input: string,
    endOfDay = false,
    tz = "UTC",
  ): Date | null {
    if (!input) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
      return ErrorLogsHelpers.parseWallClockInTz(input, time, tz);
    }
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }

  // Converts a "wall clock" date+time (e.g. 2026-06-10 + 00:00:00.000)
  // interpreted in the given IANA timezone into a UTC Date.
  // Uses Intl.DateTimeFormat to discover the offset for that date in that zone,
  // so it works correctly across DST transitions for any IANA timezone.
  private static parseWallClockInTz(
    date: string,
    time: string,
    tz: string,
  ): Date | null {
    if (tz === "UTC") {
      const d = new Date(`${date}T${time}Z`);
      return isNaN(d.getTime()) ? null : d;
    }
    // Anchor: treat the wall clock string as if it were UTC. Then ask Intl
    // what that instant LOOKS like in the target timezone, and use the gap
    // to find the actual UTC instant for the wall clock in that timezone.
    const anchor = new Date(`${date}T${time}Z`);
    if (isNaN(anchor.getTime())) return null;
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const parts = fmt.formatToParts(anchor);
      const map: Record<string, string> = {};
      parts.forEach((p) => {
        if (p.type !== "literal") map[p.type] = p.value;
      });
      const hour = map.hour === "24" ? "00" : map.hour;
      const tzWallClock = `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}Z`;
      const tzAsUtc = new Date(tzWallClock);
      const offsetMs = tzAsUtc.getTime() - anchor.getTime();
      return new Date(anchor.getTime() - offsetMs);
    } catch {
      // Bad timezone → fall back to UTC.
      const d = new Date(`${date}T${time}Z`);
      return isNaN(d.getTime()) ? null : d;
    }
  }

  // Parses HH:MM 24-hour into total minutes since midnight (0–1439).
  // Returns null if invalid.
  public static parseTimeOfDay(input: string): number | null {
    if (!input) return null;
    const match = input.match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    const hh = parseInt(match[1], 10);
    const mm = parseInt(match[2], 10);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  // Builds a Mongoose filter from query params.
  public static buildFilter(
    params: ErrorLogsQueryParams,
  ): FilterQuery<unknown> {
    const filter: FilterQuery<unknown> = {};
    const tz = params.timezone || "UTC";

    if (params.from || params.to) {
      const range: Record<string, Date> = {};
      if (params.from) {
        const fromDate = ErrorLogsHelpers.parseDate(params.from, false, tz);
        if (fromDate) range.$gte = fromDate;
      }
      if (params.to) {
        const toDate = ErrorLogsHelpers.parseDate(params.to, true, tz);
        if (toDate) range.$lte = toDate;
      }
      if (Object.keys(range).length > 0) filter.occurredAt = range;
    }

    // Time-of-day filter applied via $expr. Combined with timezone if provided.
    const timeFromMin = ErrorLogsHelpers.parseTimeOfDay(params.timeFrom || "");
    const timeToMin = ErrorLogsHelpers.parseTimeOfDay(params.timeTo || "");
    if (timeFromMin !== null || timeToMin !== null) {
      const tz = params.timezone || "UTC";
      const minutesOfDay = {
        $add: [
          { $multiply: [{ $hour: { date: "$occurredAt", timezone: tz } }, 60] },
          { $minute: { date: "$occurredAt", timezone: tz } },
        ],
      };
      const conds: Record<string, unknown>[] = [];
      if (timeFromMin !== null)
        conds.push({ $gte: [minutesOfDay, timeFromMin] });
      if (timeToMin !== null) conds.push({ $lte: [minutesOfDay, timeToMin] });
      filter.$expr = conds.length === 1 ? conds[0] : { $and: conds };
    }

    if (params.errorType) {
      const types = params.errorType
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (types.length === 1) {
        filter.errorType = types[0];
      } else if (types.length > 1) {
        filter.errorType = { $in: types };
      }
    }

    if (params.messageContains) {
      // Escape regex special chars so the substring is matched literally.
      const safe = params.messageContains.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      filter.message = { $regex: safe, $options: "i" };
    }

    if (params.source) {
      filter["metadata.source"] = params.source;
    }

    return filter;
  }

  // Normalises pagination + sort with sane defaults and bounds.
  public static parseOptions(params: ErrorLogsQueryParams) {
    const pageNum = Math.max(
      parseInt(params.page || "", 10) || DEFAULT_PAGE,
      1,
    );
    const limitNum = Math.min(
      Math.max(parseInt(params.limit || "", 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const sortBy = params.sortBy === "createdAt" ? "createdAt" : "occurredAt";
    const sortOrder = params.sortOrder === "asc" ? 1 : -1;
    const includeStack = params.includeStack === "true";

    return {
      page: pageNum,
      limit: limitNum,
      skip: (pageNum - 1) * limitNum,
      sort: { [sortBy]: sortOrder } as Record<string, 1 | -1>,
      includeStack,
    };
  }

  public static async find(
    filter: FilterQuery<unknown>,
    opts: { skip: number; limit: number; sort: Record<string, 1 | -1> },
  ) {
    return ErrorLogs.find(filter)
      .sort(opts.sort)
      .skip(opts.skip)
      .limit(opts.limit)
      .lean();
  }

  public static async count(filter: FilterQuery<unknown>): Promise<number> {
    return ErrorLogs.countDocuments(filter);
  }

  // Formats a Date into { iso, readable } in the requested timezone.
  // `readable` uses 12-hour format with AM/PM (e.g. "Jun 10, 2026 at 11:37 PM").
  public static formatDate(
    value: Date | string | undefined,
    timezone = "UTC",
  ): { iso: string; readable: string } {
    if (!value) return { iso: "", readable: "" };
    const d = value instanceof Date ? value : new Date(value);
    const iso = d.toISOString();
    let readable: string;
    try {
      readable = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(d);
    } catch {
      // Fall back to UTC if the timezone is invalid.
      readable = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(d);
    }
    return { iso, readable };
  }

  // Transforms a raw doc into the friendly API record shape.
  public static toResponseRecord(
    doc: Record<string, unknown>,
    includeStack: boolean,
    timezone = "UTC",
  ): ErrorLogResponseRecord {
    const eventType = String(doc.errorType || "UNKNOWN");
    const meta = ErrorLogsHelpers.describe(eventType);
    return {
      id: String(doc._id),
      type: meta.label,
      eventType,
      category: meta.category,
      description: String(doc.message || ""),
      occurredAt: ErrorLogsHelpers.formatDate(
        doc.occurredAt as Date | undefined,
        timezone,
      ),
      createdAt: ErrorLogsHelpers.formatDate(
        doc.createdAt as Date | undefined,
        timezone,
      ),
      details: (doc.metadata as Record<string, unknown>) || {},
      stackTrace: includeStack ? ((doc.stack as string) ?? null) : null,
    };
  }
}
