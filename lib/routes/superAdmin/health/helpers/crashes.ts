import { CRASH_QUERY } from "../../../../constants/health";
import { SentryApi, settleSentryCalls } from "../../../../services/sentryApi";
import {
  ICrashFreeByReleaseResponse,
  ICrashFreeDay,
  ICrashFreeRelease,
  ICrashImpactResponse,
  ICrashedDevicesResponse,
  IDeviceCrashesResponse,
  IHealthFilters,
} from "../../../../utils/interfaces/health";
import { HealthShared } from "./shared";
import { HealthUsers } from "./users";

/**
 * Crash reporting: crash-free rates per release, which devices crash, and who
 * is affected.
 *
 * A leaf area — nothing in `helpers.ts` calls into it, and it reaches only
 * `shared` and `users`, so the import graph stays one-way.
 */
export class HealthCrashes {
  /**
   * Crash-free users per release, for one platform.
   */
  public static getCrashFreeByRelease = async (
    filters: IHealthFilters,
  ): Promise<ICrashFreeByReleaseResponse> => {
    const scoped: IHealthFilters = {
      range: filters.range,
      platform: filters.platform,
    };
    const sessionsQuery = await HealthShared.sessionsFilterQuery(scoped);

    const result = await SentryApi.querySessions({
      fields: ["crash_free_rate(user)", "sum(session)", "count_unique(user)"],
      groupBy: ["release"],
      statsPeriod: filters.range,
      interval: "1d",
      query: sessionsQuery,
    });

    const intervals = result.intervals || [];
    const rows: ICrashFreeRelease[] = (result.groups || [])
      .map((group) => {
        const rateSeries = group.series?.["crash_free_rate(user)"] || [];
        const sessionSeries = group.series?.["sum(session)"] || [];
        const userSeries = group.series?.["count_unique(user)"] || [];

        const series: ICrashFreeDay[] = [];
        intervals.forEach((day, index) => {
          const sessions = Math.round(sessionSeries[index] ?? 0);
          // A day the build was not in use is omitted, never sent as 0 — that
          // would draw as "every user crashed".
          if (sessions <= 0) return;
          series.push({
            day,
            rate: Math.round((rateSeries[index] ?? 0) * 1000) / 10,
            users: Math.round(userSeries[index] ?? 0),
            sessions,
          });
        });

        return {
          release: group.by?.release || "unknown",
          crashFreeRate:
            Math.round((group.totals?.["crash_free_rate(user)"] ?? 0) * 1000) /
            10,
          users: Math.round(group.totals?.["count_unique(user)"] ?? 0),
          sessions: Math.round(group.totals?.["sum(session)"] ?? 0),
          series,
        };
      })
      .filter((row) => row.sessions > 0)
      .sort((first, second) => second.sessions - first.sessions);

    return {
      platform: filters.platform,
      rows,
      meta: { cachedAt: new Date().toISOString(), staleSources: [] },
    };
  };

  public static getCrashImpact = async (
    filters: IHealthFilters,
    issueId: string,
    limit: number,
  ): Promise<ICrashImpactResponse> => {
    const groupId = issueId.replace(/\D/g, "");
    if (!groupId) {
      throw new Error(`Invalid issue id: ${issueId}`);
    }
    const query = HealthShared.buildQuery(filters, `issue.id:${groupId}`);
    const statsPeriod = filters.range;

    const { results, staleSources } = await settleSentryCalls({
      totals: () =>
        SentryApi.queryEvents({
          fields: ["count()", "count_unique(user)", "count_unique(device)"],
          query,
          statsPeriod,
        }),
      byDevice: () =>
        SentryApi.queryEvents({
          fields: ["device", "os", "count()", "count_unique(user)"],
          query,
          statsPeriod,
          sort: "-count()",
          perPage: limit,
        }),
      byUser: () =>
        SentryApi.queryEvents({
          fields: ["user.id", "count()", "last_seen()"],
          query,
          statsPeriod,
          sort: "-count()",
          perPage: limit,
        }),
    });

    const userRows = results.byUser?.rows || [];
    const totalsRow = results.totals?.rows?.[0];

    return {
      issueId: groupId,
      totals: {
        crashes: HealthShared.toNumber(totalsRow?.["count()"]),
        // Distinct handset MODELS, not installs — `app.device` is on only a
        // third of crash events, so per-install cannot be counted honestly.
        devicesAffected: HealthShared.toNumber(
          totalsRow?.["count_unique(device)"],
        ),
        usersAffected: HealthShared.toNumber(totalsRow?.["count_unique(user)"]),
      },
      devices: (results.byDevice?.rows || []).map((row) => ({
        model: String(row.device || "unknown"),
        os: String(row.os || "unknown"),
        crashes: HealthShared.count(row),
        usersAffected: HealthShared.toNumber(row["count_unique(user)"]),
      })),
      users: userRows.map((row) => ({
        userId: String(row["user.id"] || ""),
        crashes: HealthShared.count(row),
        lastSeenAt: HealthShared.isoOrNull(row["last_seen()"] ?? null),
      })),
      meta: { cachedAt: new Date().toISOString(), staleSources },
    };
  };

  /** Handsets that crashed in the range, worst first. Cursor-paginated. */
  public static getCrashedDevices = async (
    filters: IHealthFilters,
    limit: number,
    cursor?: string,
  ): Promise<ICrashedDevicesResponse> => {
    const { rows, nextCursor } = await SentryApi.queryEvents({
      fields: ["device", "os", "count()", "count_unique(user)", "last_seen()"],
      query: HealthShared.buildQuery(filters, CRASH_QUERY),
      statsPeriod: filters.range,
      sort: "-count()",
      perPage: limit,
      cursor,
    });

    return {
      rows: rows.map((row) => ({
        device: String(row.device || "unknown"),
        os: String(row.os || "unknown"),
        crashes: HealthShared.count(row),
        usersAffected: HealthShared.toNumber(row["count_unique(user)"]),
        lastCrashAt: HealthShared.isoOrNull(row["last_seen()"] ?? null),
      })),
      nextCursor,
      meta: { cachedAt: new Date().toISOString(), staleSources: [] },
    };
  };

  public static getDeviceCrashes = async (
    filters: IHealthFilters,
    device: string,
    os: string,
    limit: number,
    cursor?: string,
  ): Promise<IDeviceCrashesResponse> => {
    const scoped =
      `${CRASH_QUERY} device:${HealthShared.quote(device)} ` +
      `os:${HealthShared.quote(os)}`;

    const [{ rows, nextCursor }, totalsResult] = await Promise.all([
      SentryApi.queryEvents({
        fields: [
          "id",
          "timestamp",
          "title",
          "issue",
          "culprit",
          "release",
          "mechanism",
          "level",
          "user.id",
        ],
        query: HealthShared.buildQuery(filters, scoped),
        statsPeriod: filters.range,
        sort: "-timestamp",
        perPage: limit,
        cursor,
      }),
      SentryApi.queryEvents({
        fields: ["count()", "count_unique(issue)", "count_unique(user)"],
        query: HealthShared.buildQuery(filters, scoped),
        statsPeriod: filters.range,
      }),
    ]);

    const names = await HealthUsers.resolveUserNames(
      rows.map((row) => String(row["user.id"] || "")).filter(Boolean),
    );
    const totalsRow = totalsResult.rows?.[0];

    return {
      device: { model: device, os },
      totals: {
        crashes: HealthShared.toNumber(totalsRow?.["count()"]),
        distinctIssues: HealthShared.toNumber(
          totalsRow?.["count_unique(issue)"],
        ),
        usersAffected: HealthShared.toNumber(totalsRow?.["count_unique(user)"]),
      },
      rows: rows.map((row) => {
        const issue = row.issue ? String(row.issue) : null;
        const userId = row["user.id"] ? String(row["user.id"]) : null;
        return {
          eventId: row.id ? String(row.id) : null,
          userId,
          userName: userId ? names.get(userId)?.name || null : null,
          at: String(row.timestamp || ""),
          title: String(row.title || "Unknown error"),
          issue,
          culprit: row.culprit ? String(row.culprit) : null,
          release: row.release ? String(row.release) : null,
          os,
          device,
          deviceClass: null,
          mechanism: row.mechanism ? String(row.mechanism) : null,
          level: row.level ? String(row.level) : null,
          sentryUrl: SentryApi.issueSearchUrl(
            issue ? `issue:${issue}` : scoped,
          ),
        };
      }),
      nextCursor,
      meta: { cachedAt: new Date().toISOString(), staleSources: [] },
    };
  };
}
