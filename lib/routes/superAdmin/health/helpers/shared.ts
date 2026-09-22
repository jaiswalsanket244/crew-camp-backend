import { SESSIONS_RELEASE_CAP, TAG } from "../../../../constants/health";
import { SENTRY_MAX_PER_PAGE, SentryApi } from "../../../../services/sentryApi";
import {
  ICrashException,
  ISentryEventsQuery,
  IFailureReason,
  IHealthFilters,
  IResultCounts,
  ISentryEventRow,
  IStuckAgeBucket,
} from "../../../../utils/interfaces/health";

/**
 * Pure helpers for the health dashboard: coercion, rates, pivots, bucketing.
 *
 * Split out of `helpers.ts` because these are used by more than one area.
 * Almost all are pure — they only reshape rows already fetched — the exception
 * being `sessionsFilterQuery`, which lives here because both the crash and the
 * overview code need it and neither owns it.
 */
export class HealthShared {
  public static pagedRows = async (
    options: ISentryEventsQuery,
    maxPages = 4,
  ): Promise<{ rows: ISentryEventRow[]; truncated: boolean }> => {
    const all: ISentryEventRow[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await SentryApi.queryEvents({
        ...options,
        perPage: SENTRY_MAX_PER_PAGE,
        cursor,
      });
      all.push(...result.rows);
      if (!result.nextCursor) return { rows: all, truncated: false };
      cursor = result.nextCursor;
    }

    return { rows: all, truncated: true };
  };

  public static sessionsFilterQuery = async (
    filters: IHealthFilters,
  ): Promise<string | undefined> => {
    if (filters.release) {
      return `release:"${filters.release.replace(/"/g, '\\"')}"`;
    }
    if (!filters.platform || filters.platform === "all") return undefined;

    const { rows } = await SentryApi.queryEvents({
      fields: ["release", "count()"],
      query: HealthShared.buildQuery({
        range: filters.range,
        platform: filters.platform,
      }),
      statsPeriod: filters.range,
      sort: "-count()",
      perPage: 100,
    });

    const releases: string[] = [];
    for (const row of rows) {
      const release = String(row.release || "").trim();
      // Busiest first, so the cap below keeps the builds people are actually on.
      if (release && !releases.includes(release)) releases.push(release);
    }

    if (!releases.length) return undefined;
    const capped = releases.slice(0, SESSIONS_RELEASE_CAP);
    return `release:[${capped
      .map((release) => `"${release.replace(/"/g, '\\"')}"`)
      .join(", ")}]`;
  };
  public static buildQuery = (
    filters: IHealthFilters,
    ...extra: string[]
  ): string => {
    const tokens: string[] = [];

    if (filters.platform === "ios") tokens.push("os.name:iOS");
    if (filters.platform === "android") tokens.push("os.name:Android");
    if (filters.release)
      tokens.push(`release:${HealthShared.quote(filters.release)}`);
    if (filters.network) tokens.push(`networkClass:${filters.network}`);
    if (filters.connectivity)
      tokens.push(`connectivity:${filters.connectivity}`);
    if (filters.company)
      tokens.push(`companyId:${HealthShared.quote(filters.company)}`);
    if (filters.jsBundle)
      tokens.push(`jsBundle:${HealthShared.quote(filters.jsBundle)}`);

    return [...tokens, ...extra.filter(Boolean)].join(" ");
  };

  /** Sentry needs values containing spaces or colons quoted. */
  public static quote = (value: string): string => {
    return /[\s:"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  };
  public static toNumber = (value: string | number | null): number => {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };

  /** Percentage to one decimal. Returns 0 rather than NaN on a zero denominator. */
  /** Percentage to one decimal. Returns 0 rather than NaN on a zero denominator. */
  public static rate = (numerator: number, denominator: number): number => {
    if (denominator <= 0) return 0;
    return Math.round((numerator / denominator) * 1000) / 10;
  };
  public static rateOrNull = (
    numerator: number,
    denominator: number,
  ): number | null => {
    if (denominator <= 0) return null;
    return HealthShared.rate(numerator, denominator);
  };
  public static toFailureReasons = (
    rows: ISentryEventRow[],
  ): IFailureReason[] => {
    const total = rows.reduce((sum, row) => sum + HealthShared.count(row), 0);

    return rows
      .map((row) => ({
        category: String(row[TAG.category] || "unknown"),
        stage: String(row[TAG.stage] || "unknown"),
        reason: String(row[TAG.code] || "unknown"),
        count: HealthShared.count(row),
        users: HealthShared.toNumber(row["count_unique(user)"]),
        share: HealthShared.rate(HealthShared.count(row), total),
      }))
      .sort((first, second) => second.count - first.count);
  };
  public static toResultSplit = (
    rows: ISentryEventRow[],
    tag: string,
  ): Array<{
    key: string;
    started: number;
    success: number;
    failures: number;
    users: number;
    successRate: number | null;
  }> => {
    const pivot = new Map<
      string,
      { started: number; success: number; failure: number; users: number }
    >();

    for (const row of rows) {
      const key = String(row[tag] || "unknown");
      const result = String(row.result || "");
      const count = HealthShared.count(row);
      const entry = pivot.get(key) || {
        started: 0,
        success: 0,
        failure: 0,
        users: 0,
      };

      if (result === "started") entry.started += count;
      if (result === "success") entry.success += count;
      if (result === "failure") entry.failure += count;
      // count_unique is per row, so the most any single result contributed is
      // the closest honest answer for the group — summing would double-count.
      entry.users = Math.max(
        entry.users,
        HealthShared.toNumber(row["count_unique(user)"]),
      );
      pivot.set(key, entry);
    }

    return Array.from(pivot.entries())
      .map(([key, counts]) => {
        const outcomes = counts.success + counts.failure;
        return {
          key,
          started: outcomes || counts.started,
          success: counts.success,
          failures: counts.failure,
          users: counts.users,
          successRate: HealthShared.rateOrNull(counts.success, outcomes),
        };
      })
      .sort((first, second) => second.started - first.started);
  };
  public static pointsVsFleet = (
    subject: number | null,
    fleet: number,
  ): number | null => {
    if (subject === null) return null;
    return Math.round((subject - fleet) * 10) / 10;
  };
  public static readonly CRASH_FRAME_LIMIT = 25;
  public static toCrashException = (
    data: Record<string, unknown> | undefined,
  ): ICrashException | null => {
    const values = (data?.values || []) as Record<string, unknown>[];
    const first = values[0];
    if (!first) return null;

    const stacktrace = (first.stacktrace || {}) as Record<string, unknown>;
    const allFrames = (stacktrace.frames || []) as Record<string, unknown>[];
    const kept = allFrames.slice(-HealthShared.CRASH_FRAME_LIMIT);
    const mechanism = (first.mechanism || {}) as Record<string, unknown>;

    return {
      type: HealthShared.asString(first.type),
      value: HealthShared.asString(first.value),
      mechanism: HealthShared.asString(mechanism.type),
      frames: kept.map((frame) => ({
        file:
          HealthShared.asString(frame.filename) ||
          HealthShared.asString(frame.module),
        function: HealthShared.asString(frame.function),
        line: HealthShared.asNumber(frame.lineNo),
        inApp: frame.inApp === true,
      })),
      truncated: allFrames.length > kept.length,
    };
  };

  /**
   * Walk every page of a grouped query.
   *
   * Duration buckets are 10 seconds wide, so one query can produce a few hundred
   * groups — well past Sentry's 100-row page. Taking only the first page would
   * silently drop the tail, and with durations the tail is the slow uploads,
   * which is the entire point of measuring. Truncation is reported rather than
   * hidden.
   */
  public static durationStats = (
    rows: ISentryEventRow[],
    bucketField: string,
  ): { meanSec: number | null; medianSec: number | null; samples: number } => {
    const buckets: Array<{ value: number; count: number }> = [];
    let total = 0;
    let weighted = 0;

    for (const row of rows) {
      const count = HealthShared.count(row);
      // A row with no bucket is an event from before the app reported one; it
      // must not count as "0 seconds".
      const raw = row[bucketField];
      if (raw === undefined || raw === null || String(raw) === "") continue;
      const value = HealthShared.toNumber(raw);
      buckets.push({ value, count });
      total += count;
      weighted += value * count;
    }

    if (total <= 0) return { meanSec: null, medianSec: null, samples: 0 };

    buckets.sort((first, second) => first.value - second.value);
    const middle = total / 2;
    let seen = 0;
    let medianSec = buckets[buckets.length - 1]?.value ?? null;
    for (const bucket of buckets) {
      seen += bucket.count;
      if (seen >= middle) {
        medianSec = bucket.value;
        break;
      }
    }

    return {
      meanSec: Math.round(weighted / total),
      medianSec,
      samples: total,
    };
  };

  /** `durationStats`, split by a grouping tag. */
  /** `durationStats`, split by a grouping tag. */
  public static durationStatsByKey = (
    rows: ISentryEventRow[],
    keyField: string,
    bucketField: string,
  ): Map<
    string,
    { meanSec: number | null; medianSec: number | null; samples: number }
  > => {
    const grouped = new Map<string, ISentryEventRow[]>();
    for (const row of rows) {
      const key = String(row[keyField] || "unknown");
      const list = grouped.get(key) || [];
      list.push(row);
      grouped.set(key, list);
    }

    const out = new Map<
      string,
      { meanSec: number | null; medianSec: number | null; samples: number }
    >();
    grouped.forEach((list, key) => {
      out.set(key, HealthShared.durationStats(list, bucketField));
    });
    return out;
  };

  /** Timing for one split row, or empty timing when nothing was measured. */
  /** Timing for one split row, or empty timing when nothing was measured. */
  public static timingFor = (
    stats: Map<
      string,
      { meanSec: number | null; medianSec: number | null; samples: number }
    >,
    key: string,
  ): {
    meanTotalSec: number | null;
    medianTotalSec: number | null;
    timingSamples: number;
  } => {
    const entry = stats.get(key);
    return {
      meanTotalSec: entry?.meanSec ?? null,
      medianTotalSec: entry?.medianSec ?? null,
      timingSamples: entry?.samples ?? 0,
    };
  };

  /** A count is only a fact once we know the instrumentation is reporting. */
  /** A count is only a fact once we know the instrumentation is reporting. */
  public static countOrNull = (
    value: number,
    measured: boolean,
  ): number | null => {
    return measured ? value : null;
  };

  public static count = (row: ISentryEventRow): number => {
    const posts = row[HealthShared.POSTS_FIELD];
    if (posts !== undefined && posts !== null && String(posts) !== "") {
      return HealthShared.toNumber(posts);
    }
    return HealthShared.toNumber(row["count()"]);
  };

  public static readonly POSTS_FIELD = "count_unique(postId)";

  public static attempts = (row: ISentryEventRow): number => {
    return HealthShared.toNumber(row["count()"]);
  };

  public static weightedSum = (
    rows: ISentryEventRow[],
    valueField: string,
  ): number => {
    return rows.reduce(
      (total, row) =>
        total +
        HealthShared.toNumber(row[valueField]) * HealthShared.count(row),
      0,
    );
  };
  public static totalsByResult = (rows: ISentryEventRow[]): IResultCounts => {
    const totals: IResultCounts = { started: 0, success: 0, failure: 0 };

    for (const row of rows) {
      const result = String(row.result || "");
      const count = HealthShared.count(row);
      if (result === "started") totals.started += count;
      if (result === "success") totals.success += count;
      if (result === "failure") totals.failure += count;
    }

    return totals;
  };
  public static countForResult = (
    rows: ISentryEventRow[],
    result: string,
  ): number => {
    return rows
      .filter((row) => String(row.result || "") === result)
      .reduce((total, row) => total + HealthShared.count(row), 0);
  };

  /** Pivot `group by <key>, result` rows into one entry per key. */
  /** Pivot `group by <key>, result` rows into one entry per key. */
  public static pivotByResult = (
    rows: ISentryEventRow[],
    keyField: string,
  ): Map<string, IResultCounts> => {
    const pivot = new Map<string, IResultCounts>();

    for (const row of rows) {
      const key = String(row[keyField] || "unknown");
      const result = String(row.result || "");
      const count = HealthShared.count(row);

      const entry = pivot.get(key) || { started: 0, success: 0, failure: 0 };
      if (result === "started") entry.started += count;
      if (result === "success") entry.success += count;
      if (result === "failure") entry.failure += count;
      pivot.set(key, entry);
    }

    return pivot;
  };

  public static denominator = (counts: IResultCounts): number => {
    return counts.started || counts.success + counts.failure;
  };

  public static inProgress = (counts: IResultCounts): number => {
    return Math.max(0, counts.started - counts.success - counts.failure);
  };

  public static postsAttempted = (
    counts: IResultCounts,
    permanentPosts = 0,
  ): number => {
    if (counts.started <= 0) return counts.success + counts.failure;

    return Math.max(counts.started, counts.success + permanentPosts);
  };

  /** `permanentPosts`, split by a grouping key. */
  public static permanentPostsByKey = (
    rows: ISentryEventRow[],
    keyField: string,
  ): Map<string, number> => {
    const byKey = new Map<string, number>();
    for (const row of rows) {
      if (String(row.result || "") !== "failure") continue;
      if (String(row[TAG.category] || "") !== "permanent") continue;
      const key = String(row[keyField] || "unknown");
      byKey.set(key, (byKey.get(key) || 0) + HealthShared.count(row));
    }
    return byKey;
  };

  /** Posts whose failure was permanent. Needs `failureCategory` in the query. */
  public static permanentPosts = (rows: ISentryEventRow[]): number => {
    return rows
      .filter(
        (row) =>
          String(row.result || "") === "failure" &&
          String(row[TAG.category] || "") === "permanent",
      )
      .reduce((total, row) => total + HealthShared.count(row), 0);
  };
  public static latestPerKey = (
    rows: ISentryEventRow[],
    ...keyFields: string[]
  ): ISentryEventRow[] => {
    const latest = new Map<string, ISentryEventRow>();

    for (const row of rows) {
      const key = keyFields
        .map((field) => String(row[field] || ""))
        .filter(Boolean)
        .join("|");
      if (!key) continue;

      const existing = latest.get(key);
      if (
        !existing ||
        String(row.timestamp || "") > String(existing.timestamp || "")
      ) {
        latest.set(key, row);
      }
    }

    return Array.from(latest.values());
  };
  public static bucketAges = (ages: number[]): IStuckAgeBucket[] => {
    const buckets = [
      { bucket: "8-24h", devices: 0, min: 8, max: 24 },
      { bucket: "24-72h", devices: 0, min: 24, max: 72 },
      { bucket: ">72h", devices: 0, min: 72, max: Infinity },
    ];

    for (const age of ages) {
      const match = buckets.find((b) => age >= b.min && age < b.max);
      if (match) match.devices += 1;
    }

    return buckets.map(({ bucket, devices }) => ({ bucket, devices }));
  };

  /**
   * Collapse `group by timestamp.to_day, result` rows into one point per day.
   *
   * If an org rejects `timestamp.to_day`, swap the calling query for the
   * /events-stats/ endpoint — nothing else in the response depends on it.
   */
  /**
   * Collapse `group by timestamp.to_day, result` rows into one point per day.
   *
   * If an org rejects `timestamp.to_day`, swap the calling query for the
   * /events-stats/ endpoint — nothing else in the response depends on it.
   */
  public static seriesByDay = (
    rows: ISentryEventRow[],
    resultKeys: string[],
  ): Array<{ day: string; counts: Record<string, number> }> => {
    const byDay = new Map<string, Record<string, number>>();

    for (const row of rows) {
      const day = String(row["timestamp.to_day"] || "");
      if (!day) continue;

      const entry = byDay.get(day) || {};
      const result = String(row.result || "");
      if (resultKeys.includes(result)) {
        entry[result] = (entry[result] || 0) + HealthShared.count(row);
      }
      byDay.set(day, entry);
    }

    return Array.from(byDay.entries())
      .map(([day, counts]) => ({ day, counts }))
      .sort((first, second) => first.day.localeCompare(second.day));
  };

  public static categoryByDay = (
    rows: ISentryEventRow[],
    category: string,
  ): Map<string, number> => {
    const byDay = new Map<string, number>();

    for (const row of rows) {
      if (String(row.result || "") !== "failure") continue;
      if (String(row[TAG.category] || "") !== category) continue;
      const day = String(row["timestamp.to_day"] || "");
      if (!day) continue;
      byDay.set(day, (byDay.get(day) || 0) + HealthShared.count(row));
    }

    return byDay;
  };

  public static splitDay = (input: {
    started: number;
    success: number;
    permanent: number;
    transient: number;
  }): { permanent: number; retrying: number; inProgress: number } => {
    const attempted = Math.max(input.started, input.success + input.permanent);
    const undelivered = Math.max(0, attempted - input.success);
    const permanent = Math.min(input.permanent, undelivered);

    const retrying = Math.min(input.transient, undelivered - permanent);
    return {
      permanent,
      retrying,
      inProgress: undelivered - permanent - retrying,
    };
  };

  public static lostPeople = (rows: ISentryEventRow[]): number => {
    return HealthShared.toNumber(rows[0]?.["count_unique(user)"] ?? null);
  };

  public static lostFootnote = (
    rows: ISentryEventRow[],
    people: number,
  ): string => {
    const lost = HealthShared.weightedSum(rows, "filesFailed");
    if (!lost) return "None lost — clean";

    const total = HealthShared.weightedSum(rows, "filesInPost");
    const scope =
      total >= lost
        ? `${lost} of ${total} photos in those posts`
        : `${lost} photos`;
    return `${scope} · ${people} ${people === 1 ? "person" : "people"} affected`;
  };

  public static isoOrNull = (value: string | number | null): string | null => {
    if (!value) return null;
    return String(value);
  };

  /** Within the last 7 days of now. */
  /** Within the last 7 days of now. */
  public static isActiveThisWeek = (lastSeenAt: string | null): boolean => {
    if (!lastSeenAt) return false;
    const seen = new Date(lastSeenAt).getTime();
    if (Number.isNaN(seen)) return false;
    return Date.now() - seen <= 7 * 24 * 60 * 60 * 1000;
  };
  public static asNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  public static asBool = (value: unknown): boolean | null => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  };
  public static asString = (value: unknown): string | null => {
    if (value === null || value === undefined || value === "") return null;
    return String(value);
  };

  public static crashFreeScopeNote = (
    filters: IHealthFilters,
    people: number,
  ): string => {
    const platform = filters.platform === "android" ? "Android" : "iOS";
    const build = filters.release
      ? filters.release.split("@")[1] || filters.release
      : "all versions";
    const reach = people
      ? `${people.toLocaleString()} people`
      : "no session data";
    return `${platform} · ${build} · last ${filters.range} · ${reach}`;
  };
}
