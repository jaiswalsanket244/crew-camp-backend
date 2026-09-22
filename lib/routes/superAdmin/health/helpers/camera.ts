import { CAMERA_FLOW, CAMERA_ISSUE_QUERY } from "../../../../constants/health";
import { SentryApi, settleSentryCalls } from "../../../../services/sentryApi";
import {
  ICameraDeviceIssuesResponse,
  ICameraIssueDevicesResponse,
  ICameraReport,
  IHealthFilters,
} from "../../../../utils/interfaces/health";
import { HealthShared } from "./shared";
import { HealthUsers } from "./users";

export class HealthCamera {
  /** Handsets with camera trouble in the range, worst first. */
  public static getCameraIssueDevices = async (
    filters: IHealthFilters,
    limit: number,
    cursor?: string,
  ): Promise<ICameraIssueDevicesResponse> => {
    const { rows, nextCursor } = await SentryApi.queryEvents({
      fields: ["device", "os", "count()", "count_unique(user)", "last_seen()"],
      query: HealthShared.buildQuery(filters, CAMERA_ISSUE_QUERY),
      statsPeriod: filters.range,
      sort: "-count()",
      perPage: limit,
      cursor,
    });

    return {
      rows: rows.map((row) => ({
        device: String(row.device || "unknown"),
        os: String(row.os || "unknown"),
        issues: HealthShared.count(row),
        usersAffected: HealthShared.toNumber(row["count_unique(user)"]),
        lastIssueAt: HealthShared.isoOrNull(row["last_seen()"] ?? null),
      })),
      nextCursor,
      meta: { cachedAt: new Date().toISOString(), staleSources: [] },
    };
  };

  /** Every camera issue on one handset model, newest first. */
  public static getCameraDeviceIssues = async (
    filters: IHealthFilters,
    device: string,
    os: string,
    limit: number,
    cursor?: string,
  ): Promise<ICameraDeviceIssuesResponse> => {
    const scoped =
      `${CAMERA_ISSUE_QUERY} device:${HealthShared.quote(device)} ` +
      `os:${HealthShared.quote(os)}`;

    const [{ rows, nextCursor }, totalResult] = await Promise.all([
      SentryApi.queryEvents({
        fields: [
          "id",
          "timestamp",
          "title",
          "culprit",
          "stage",
          "failureCode",
          "release",
          "error.unhandled",
          "user.id",
        ],
        query: HealthShared.buildQuery(filters, scoped),
        statsPeriod: filters.range,
        sort: "-timestamp",
        perPage: limit,
        cursor,
      }),
      SentryApi.queryEvents({
        fields: ["count()"],
        query: HealthShared.buildQuery(filters, scoped),
        statsPeriod: filters.range,
      }),
    ]);

    const names = await HealthUsers.resolveUserNames(
      rows.map((row) => String(row["user.id"] || "")).filter(Boolean),
    );

    return {
      device: { model: device, os },
      total: HealthShared.toNumber(totalResult.rows?.[0]?.["count()"]),
      rows: rows.map((row) => {
        const userId = row["user.id"] ? String(row["user.id"]) : null;
        return {
          eventId: row.id ? String(row.id) : null,
          userId,
          userName: userId ? names.get(userId)?.name || null : null,
          at: String(row.timestamp || ""),
          title: String(row.title || "Camera issue"),
          // Discover returns this as `1`/`0`, not `true`/`false`.
          kind: ["1", "true"].includes(String(row["error.unhandled"]))
            ? "crash"
            : "failed",
          stage: row.stage ? String(row.stage) : null,
          code: row.failureCode ? String(row.failureCode) : null,
          culprit: row.culprit ? String(row.culprit) : null,
          release: row.release ? String(row.release) : null,
          device,
          os,
        };
      }),
      nextCursor,
      meta: { cachedAt: new Date().toISOString(), staleSources: [] },
    };
  };

  /**
   * Camera failure totals.
   *
   * Two queries. No success rate: the app records failures only (see
   * `CameraTelemetry`), so there is no denominator and inventing one would be
   * worse than not having it. Crashes are inferred as issues minus reported
   * failures rather than queried a third time.
   */
  public static getCameraReport = async (
    filters: IHealthFilters,
  ): Promise<ICameraReport> => {
    const statsPeriod = filters.range;

    const { results, staleSources } = await settleSentryCalls({
      issues: () =>
        SentryApi.queryEvents({
          fields: ["count()", "count_unique(device)"],
          query: HealthShared.buildQuery(filters, CAMERA_ISSUE_QUERY),
          statsPeriod,
        }),
      reported: () =>
        SentryApi.queryEvents({
          fields: ["count()"],
          query: HealthShared.buildQuery(
            filters,
            `${CAMERA_FLOW} result:failed`,
          ),
          statsPeriod,
        }),
    });

    const issues = HealthShared.toNumber(
      results.issues?.rows?.[0]?.["count()"],
    );
    const reportedFailures = HealthShared.toNumber(
      results.reported?.rows?.[0]?.["count()"],
    );

    return {
      filters,
      totals: {
        issues,
        reportedFailures,
        // Never negative: the two queries are independent, and a partial failure
        // of either would otherwise produce a nonsense crash count.
        crashes: Math.max(0, issues - reportedFailures),
        // Distinct handset MODELS. `app.device` (per install) is on only a third
        // of crash events, so it cannot be counted honestly.
        devicesAffected: HealthShared.toNumber(
          results.issues?.rows?.[0]?.["count_unique(device)"],
        ),
      },
      meta: { cachedAt: new Date().toISOString(), staleSources },
    };
  };
}
