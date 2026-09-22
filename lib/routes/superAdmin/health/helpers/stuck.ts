import {
  STUCK_LOOKBACK,
  STUCK_POST_QUERY,
  TELEMETRY_V2,
} from "../../../../constants/health";
import { SentryApi } from "../../../../services/sentryApi";
import {
  IHealthFilters,
  IStuckUploadList,
  IStuckUploadRow,
} from "../../../../utils/interfaces/health";
import { HealthShared } from "./shared";
import { HealthUsers } from "./users";

/** The tag reads `"24h"`, so plain Number() gives NaN and every row read 0. */
const thresholdHours = (value: string | number | null | undefined): number => {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
};

export class HealthStuck {
  private static deliveredSince = async (
    postIds: string[],
  ): Promise<Map<string, string>> => {
    if (!postIds.length) return new Map();

    const { rows } = await SentryApi.queryEvents({
      fields: ["postId", "last_seen()"],
      query:
        `${TELEMETRY_V2} flow:upload result:success ` +
        `postId:[${postIds.map((id) => `"${id}"`).join(", ")}]`,
      statsPeriod: STUCK_LOOKBACK,
      perPage: postIds.length,
    });

    const delivered = new Map<string, string>();
    for (const row of rows) {
      const postId = String(row.postId || "").trim();
      const at = HealthShared.isoOrNull(row["last_seen()"] ?? null);
      if (postId && at) delivered.set(postId, at);
    }
    return delivered;
  };

  public static getStuckUploads = async (
    filters: IHealthFilters,
    limit: number,
    cursor?: string,
  ): Promise<IStuckUploadList> => {
    const { rows, nextCursor } = await SentryApi.queryEvents({
      fields: [
        "postId",
        "user.id",
        "app.device",
        "stage",
        "phase",
        "stuckHours",
        "stuckThreshold",
        "filesInPost",
        "filesSynced",
        "filesUploadedNotSynced",
        "filesPending",
        "filesFailed",
        "last_seen()",
      ],
      query: HealthShared.buildQuery(filters, STUCK_POST_QUERY),
      statsPeriod: STUCK_LOOKBACK,
      sort: "-last_seen()",
      perPage: limit,
      cursor,
    });

    const byPost = new Map<string, IStuckUploadRow>();

    for (const row of rows) {
      const postId = String(row.postId || "").trim();
      if (!postId) continue;

      const threshold = thresholdHours(row.stuckThreshold);
      const existing = byPost.get(postId);
      // Same post at several thresholds — keep the worst reading.
      if (existing && existing.threshold >= threshold) continue;

      byPost.set(postId, {
        postId,
        userId: row["user.id"] ? String(row["user.id"]) : null,
        name: null,
        email: null,
        companyName: null,
        stuckHours: thresholdHours(row.stuckHours),
        threshold,
        stage: HealthShared.asString(row.stage),
        phase: HealthShared.asString(row.phase),
        filesInPost: HealthShared.toNumber(row.filesInPost ?? null),
        filesSynced: HealthShared.toNumber(row.filesSynced ?? null),
        filesUploadedNotSynced: HealthShared.toNumber(
          row.filesUploadedNotSynced ?? null,
        ),
        filesPending: HealthShared.toNumber(row.filesPending ?? null),
        filesFailed: HealthShared.toNumber(row.filesFailed ?? null),
        device: row["app.device"] ? String(row["app.device"]) : null,
        reportedAt: HealthShared.isoOrNull(row["last_seen()"] ?? null),
      });
    }

    const delivered = await HealthStuck.deliveredSince(
      Array.from(byPost.keys()),
    );
    const collected = Array.from(byPost.values())
      .filter((row) => {
        const at = delivered.get(row.postId);
        return !at || !row.reportedAt || at <= row.reportedAt;
      })
      .sort((first, second) => second.stuckHours - first.stuckHours);

    const userIds = Array.from(
      new Set(
        collected
          .map((row) => row.userId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const names = userIds.length
      ? await HealthUsers.resolveUserNames(userIds)
      : null;

    const rowsOut = collected.map((row) => {
      const resolved = row.userId ? names?.get(row.userId) : null;
      return {
        ...row,
        name: resolved?.name || null,
        email: resolved?.email || null,
        companyName: resolved?.companyName || null,
      };
    });

    const stageCounts = new Map<string, number>();
    for (const row of rowsOut) {
      const stage = row.stage || "unknown";
      stageCounts.set(stage, (stageCounts.get(stage) || 0) + 1);
    }

    return {
      rows: rowsOut,
      total: rowsOut.length,
      byStage: Array.from(stageCounts.entries())
        .map(([stage, posts]) => ({ stage, posts }))
        .sort((first, second) => second.posts - first.posts),
      nextCursor: nextCursor || null,
      meta: { cachedAt: new Date().toISOString(), staleSources: [] },
    };
  };
}
