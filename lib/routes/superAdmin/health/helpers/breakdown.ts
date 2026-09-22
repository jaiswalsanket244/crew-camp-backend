import {
  DIMENSION_FIELD,
  METRIC_QUERY,
  TAG,
} from "../../../../constants/health";
import { SentryApi } from "../../../../services/sentryApi";
import {
  HealthDimension,
  HealthMetric,
  IBreakdownRow,
  IHealthBreakdown,
  IHealthFilters,
} from "../../../../utils/interfaces/health";
import { HealthShared } from "./shared";
import { HealthUsers } from "./users";

/**
 * Group-by breakdowns: upload outcomes sliced by any supported dimension.
 *
 * A leaf area — nothing else in the module calls into it.
 */
export class HealthBreakdown {
  public static getBreakdown = async (
    filters: IHealthFilters,
    dimension: HealthDimension,
    metric: HealthMetric,
    limit: number,
    cursor?: string,
  ): Promise<IHealthBreakdown> => {
    const groupField = DIMENSION_FIELD[dimension];

    // `result` only means something for the flow metrics. Errors and crashes
    // have no started/success/failure axis, so requesting it there would group
    // every row under an empty key and return a table of nothing.
    const hasResultAxis = metric === "upload" || metric === "drafts";
    const fields = hasResultAxis
      ? [
          groupField,
          "result",
          ...(metric === "upload" ? [TAG.category] : []),
          "count()",
          ...(metric === "upload" ? ["count_unique(postId)"] : []),
          "count_unique(user)",
          "last_seen()",
        ]
      : [groupField, "count()", "count_unique(user)", "last_seen()"];

    const { rows, nextCursor } = await SentryApi.queryEvents({
      fields,
      query: HealthShared.buildQuery(filters, METRIC_QUERY[metric]),
      statsPeriod: filters.range,
      // Rank uploads by posts, so a single post retrying all day cannot push
      // its device or network to the top of the table.
      sort: metric === "upload" ? "-count_unique(postId)" : "-count()",
      perPage: limit,
      cursor,
    });

    const metaFor = (key: string) =>
      rows.find((row) => String(row[groupField] || "") === key);

    const permanentByKey = HealthShared.permanentPostsByKey(rows, groupField);

    let breakdownRows: IBreakdownRow[] = hasResultAxis
      ? Array.from(HealthShared.pivotByResult(rows, groupField).entries()).map(
          ([key, counts]) => {
            const started = HealthShared.denominator(counts);
            const meta = metaFor(key);
            return {
              key,
              label: key,
              started,
              success: counts.success,
              failed: counts.failure,
              successRate: HealthShared.rate(
                counts.success,
                HealthShared.postsAttempted(
                  counts,
                  permanentByKey.get(key) ?? 0,
                ),
              ),
              usersAffected: HealthShared.toNumber(
                meta?.["count_unique(user)"],
              ),
              lastSeenAt: HealthShared.isoOrNull(meta?.["last_seen()"] ?? null),
            };
          },
        )
      : rows.map((row) => {
          const key = String(row[groupField] || "unknown");
          const count = HealthShared.count(row);
          return {
            key,
            label: key,
            started: count,
            success: 0,
            failed: count,
            successRate: 0,
            usersAffected: HealthShared.toNumber(row["count_unique(user)"]),
            lastSeenAt: HealthShared.isoOrNull(row["last_seen()"] ?? null),
          };
        });

    // Devices quiet for over a week are not a current problem — drop them so
    // the table answers "which handsets are struggling now".
    if (dimension === "device") {
      breakdownRows = breakdownRows.filter((row) =>
        HealthShared.isActiveThisWeek(row.lastSeenAt),
      );
    }

    const extraStale: string[] = [];

    if (dimension === "user") {
      const userIds = breakdownRows.map((row) => row.key);
      const [names, activeDayResult] = await Promise.all([
        HealthUsers.resolveUserNames(userIds),
        // Only for the upload metric — "active days" has no meaning for a
        // crash or error count.
        metric === "upload"
          ? HealthUsers.getActiveDaysForUsers(filters, userIds)
          : Promise.resolve({
              activeDays: new Map<string, number>(),
              truncated: false,
            }),
      ]);
      if (activeDayResult.truncated) extraStale.push("activeDays:truncated");

      breakdownRows = breakdownRows.map((row) => {
        const activeDays = activeDayResult.activeDays.get(row.key) ?? 0;
        const perDay = activeDays > 0 ? row.started / activeDays : 0;
        return {
          ...row,
          label: names.get(row.key)?.name || row.key,
          activeDays,
          uploadsPerActiveDay: Math.round(perDay * 10) / 10,
        };
      });
    }

    return {
      dimension,
      metric,
      rows: breakdownRows.sort((first, second) =>
        hasResultAxis
          ? first.successRate - second.successRate
          : second.failed - first.failed,
      ),
      nextCursor,
      meta: { cachedAt: new Date().toISOString(), staleSources: extraStale },
    };
  };
}
