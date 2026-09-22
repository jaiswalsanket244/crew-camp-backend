import { Company, CompanyMember, User } from "../../../../db";
import { CURRENT_COMPANY_MEMBER_STATUS } from "../../../../utils/enums/enums";
import { TAG, TELEMETRY_V2, UPLOAD_FLOW } from "../../../../constants/health";
import { SentryApi } from "../../../../services/sentryApi";
import {
  IHealthFilters,
  IReleaseOption,
  IReleasesResponse,
  IUserUploadList,
  IUserUploadRow,
} from "../../../../utils/interfaces/health";
import { HealthShared } from "./shared";

export class HealthUsers {
  /** Resolve user ids to a display name, email and company name. */
  public static resolveUserNames = async (
    userIds: string[],
  ): Promise<
    Map<
      string,
      { name: string | null; email: string | null; companyName: string | null }
    >
  > => {
    const resolved = new Map<
      string,
      { name: string | null; email: string | null; companyName: string | null }
    >();
    const validIds = userIds.filter((id) => /^[a-f\d]{24}$/i.test(id));
    if (!validIds.length) return resolved;

    // Email comes along because support's next step after seeing a crash list is
    // to contact the person; a second query for it would be wasteful.
    const users = await User.find(
      { _id: { $in: validIds } },
      { name: 1, email: 1, companyRef: 1 },
    ).lean();

    const memberships = await CompanyMember.find(
      {
        userId: { $in: validIds },
        status: CURRENT_COMPANY_MEMBER_STATUS.ACTIVE,
      },
      { userId: 1, companyId: 1 },
    ).lean();

    const companyIdByUser = new Map<string, string>(
      memberships.map((member) => [
        String(member.userId),
        String(member.companyId),
      ]),
    );

    const companyIds = Array.from(new Set(companyIdByUser.values()));
    const companies = companyIds.length
      ? await Company.find({ _id: { $in: companyIds } }, { name: 1 }).lean()
      : [];

    const companyNameById = new Map<string, string>(
      companies.map((company) => [String(company._id), company.name]),
    );

    for (const user of users) {
      resolved.set(String(user._id), {
        name: [user?.name?.first, user?.name?.last].filter(Boolean).join(" "),
        email: user.email || null,
        companyName:
          companyNameById.get(companyIdByUser.get(String(user._id)) ?? "") ??
          (user.companyRef
            ? companyNameById.get(String(user.companyRef))
            : null) ??
          null,
      });
    }

    return resolved;
  };

  public static getReleases = async (
    filters: IHealthFilters,
  ): Promise<IReleasesResponse> => {
    const { rows } = await SentryApi.queryEvents({
      fields: ["release", "os.name", "count()", "last_seen()"],
      query: HealthShared.buildQuery(filters),
      statsPeriod: filters.range,
      sort: "-last_seen()",
      perPage: 100,
    });

    const byPlatform: { [platform: string]: IReleaseOption[] } = {};
    for (const row of rows) {
      const release = String(row.release || "").trim();
      if (!release) continue;
      const platform = String(row["os.name"] || "unknown").toLowerCase();
      const option: IReleaseOption = {
        release,
        platform,
        lastSeenAt: String(row["last_seen()"] || ""),
        events: HealthShared.count(row),
      };
      byPlatform[platform] = byPlatform[platform] || [];
      byPlatform[platform].push(option);
    }

    const latestByPlatform: { [platform: string]: string } = {};
    for (const platform of Object.keys(byPlatform)) {
      byPlatform[platform].sort((a, b) =>
        b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
      latestByPlatform[platform] = byPlatform[platform][0]?.release || "";
    }

    return {
      byPlatform,
      latestByPlatform,
      meta: { cachedAt: new Date().toISOString(), staleSources: [] },
    };
  };

  // ─── Per-user active days ────────────────────────────────────────────────

  public static getActiveDaysForUsers = async (
    filters: IHealthFilters,
    userIds: string[],
  ): Promise<{ activeDays: Map<string, number>; truncated: boolean }> => {
    const activeDays = new Map<string, number>();
    if (!userIds.length) return { activeDays, truncated: false };

    const scoped = `user.id:[${userIds.map((id) => `"${id}"`).join(",")}]`;
    const maxPages = 12;
    let cursor: string | undefined;
    let truncated = false;

    for (let page = 0; page < maxPages; page += 1) {
      const { rows, nextCursor } = await SentryApi.queryEvents({
        fields: ["user.id", "timestamp.to_day", "count()"],
        query: HealthShared.buildQuery(
          filters,
          `${TELEMETRY_V2} flow:upload result:started`,
          scoped,
        ),
        statsPeriod: filters.range,
        perPage: 100,
        cursor,
      });

      for (const row of rows) {
        const userId = String(row["user.id"] || "");
        if (!userId) continue;
        activeDays.set(userId, (activeDays.get(userId) ?? 0) + 1);
      }

      if (!nextCursor) break;
      cursor = nextCursor;
      if (page === maxPages - 1) truncated = true;
    }

    return { activeDays, truncated };
  };

  // ─── Per-user upload list

  public static searchUserIds = async (
    searchValue: string,
    limit: number,
  ): Promise<Map<string, { name: string; email: string }>> => {
    const found = new Map<string, { name: string; email: string }>();
    const term = searchValue.trim();
    if (!term) return found;

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await User.find(
      {
        $or: [
          { email: { $regex: escaped, $options: "i" } },
          { "name.first": { $regex: escaped, $options: "i" } },
          { "name.last": { $regex: escaped, $options: "i" } },
        ],
      },
      { name: 1, email: 1 },
    )
      .limit(limit)
      .lean();

    for (const user of users) {
      found.set(String(user._id), {
        name: [user?.name?.first, user?.name?.last].filter(Boolean).join(" "),
        email: user.email || "",
      });
    }
    return found;
  };

  private static affectedUserIds = async (
    filters: IHealthFilters,
  ): Promise<string[]> => {
    // Either narrows on its own: "Why uploads failed" sends a reason (plus the
    // stage, because the same reason at two stages is two problems), while
    // "Where uploads fail" only has a stage to send.
    const scope: string[] = [];
    if (filters.failureCode) {
      scope.push(`${TAG.code}:${HealthShared.quote(filters.failureCode)}`);
    }
    if (filters.failureStage) {
      scope.push(`${TAG.stage}:${HealthShared.quote(filters.failureStage)}`);
    }
    if (!scope.length) return [];

    const { rows } = await SentryApi.queryEvents({
      fields: ["user.id", "count()"],
      query: HealthShared.buildQuery(
        filters,
        `${UPLOAD_FLOW} result:failure`,
        ...scope,
      ),
      statsPeriod: filters.range,
      sort: "-count()",
      perPage: 100,
    });

    return Array.from(
      new Set(
        rows.map((row) => String(row["user.id"] || "").trim()).filter(Boolean),
      ),
    );
  };

  public static getUserUploadList = async (
    filters: IHealthFilters,
    searchValue?: string,
  ): Promise<IUserUploadList> => {
    const staleSources: string[] = [];
    let scopedIds: Map<string, { name: string; email: string }> | null = null;
    let scopeToken = "";

    const empty = (searched: boolean): IUserUploadList => ({
      rows: [],
      total: 0,
      searched,
      meta: { cachedAt: new Date().toISOString(), staleSources },
    });

    if (searchValue) {
      scopedIds = await HealthUsers.searchUserIds(searchValue, 100);
      if (scopedIds.size === 0) return empty(true);
    }

    let ids = scopedIds ? Array.from(scopedIds.keys()) : null;

    if (filters.failureCode || filters.failureStage) {
      const affected = await HealthUsers.affectedUserIds(filters);
      if (!affected.length) return empty(Boolean(searchValue));
      // Both filters active: only people who match the search AND hit the
      // reason. Intersecting beats replacing — the search must still narrow.
      ids = ids ? ids.filter((id) => affected.includes(id)) : affected;
      if (!ids.length) return empty(Boolean(searchValue));
    }

    if (ids) {
      scopeToken = `user.id:[${ids.map((id) => `"${id}"`).join(",")}]`;
    }

    const { rows } = await SentryApi.queryEvents({
      fields: [
        "user.id",
        "result",
        TAG.category,
        "count()",
        "count_unique(postId)",
        "last_seen()",
      ],
      query: HealthShared.buildQuery(
        filters,
        `${TELEMETRY_V2} flow:upload`,
        scopeToken,
      ),
      statsPeriod: filters.range,
      sort: "-count_unique(postId)",
      perPage: 100,
    });

    const pivot = HealthShared.pivotByResult(rows, "user.id");
    // Without this a person whose only failed post began before the range
    // scores 100% here and 99% on their own page — see postsAttempted.
    const permanentByUser = HealthShared.permanentPostsByKey(rows, "user.id");
    const ranked = Array.from(pivot.entries())
      .map(([userId, counts]) => {
        const started = HealthShared.denominator(counts);
        const meta = rows.find(
          (row) => String(row["user.id"] || "") === userId,
        );
        return {
          userId,
          started,
          success: counts.success,
          failed: counts.failure,
          permanentFailed: permanentByUser.get(userId) ?? 0,
          inProgress: HealthShared.inProgress(counts),
          successRate: HealthShared.rate(
            counts.success,
            HealthShared.postsAttempted(
              counts,
              permanentByUser.get(userId) ?? 0,
            ),
          ),
          lastSeenAt: HealthShared.isoOrNull(meta?.["last_seen()"] ?? null),
        };
      })
      .filter((row) => row.started > 0)
      .sort((first, second) => {
        const firstRated = first.success + first.failed > 0;
        const secondRated = second.success + second.failed > 0;
        if (firstRated !== secondRated) return firstRated ? -1 : 1;
        return first.successRate - second.successRate;
      });

    const userIds = ranked.map((row) => row.userId);
    const [names, activeDayResult] = await Promise.all([
      HealthUsers.resolveUserNames(userIds),
      HealthUsers.getActiveDaysForUsers(filters, userIds),
    ]);
    if (activeDayResult.truncated) staleSources.push("activeDays:truncated");

    const rowsOut: IUserUploadRow[] = ranked.map((row) => {
      const activeDays = activeDayResult.activeDays.get(row.userId) ?? 0;
      const perDay = activeDays > 0 ? row.started / activeDays : 0;
      const searched = scopedIds?.get(row.userId);
      const resolved = names?.get(row.userId);
      return {
        ...row,
        name: resolved?.name || searched?.name || null,
        email: resolved?.email || searched?.email || null,
        companyName: resolved?.companyName || null,
        activeDays,
        uploadsPerActiveDay: Math.round(perDay * 10) / 10,
      };
    });

    return {
      rows: rowsOut,
      total: rowsOut.length,
      searched: Boolean(searchValue),
      meta: { cachedAt: new Date().toISOString(), staleSources },
    };
  };
}
