import { HealthShared } from "./helpers/shared";
import { HealthUsers } from "./helpers/users";
import { SentryApi, settleSentryCalls } from "../../../services/sentryApi";
import {
  IHealthFilters,
  IHealthDetail,
  IHealthOverview,
  IHealthSummary,
  IUploadDayPoint,
  IWorstUser,
} from "../../../utils/interfaces/health";
import {
  STUCK_SNAPSHOT_QUERY,
  WORST_LIMIT,
  PER_PERSON_PAGES,
  TELEMETRY_V2,
  UPLOAD_FLOW,
  PHOTOS_LOST_QUERY,
  TAG,
  NOT_MEASURED_NOTE,
  FAILURE_CATEGORY,
} from "../../../constants/health";

export class HealthHelpers {
  public static getSummary = async (
    filters: IHealthFilters,
  ): Promise<IHealthSummary> => {
    const statsPeriod = filters.range;

    const sessionsQuery = await HealthShared.sessionsFilterQuery(filters);

    const { results, staleSources } = await settleSentryCalls({
      uploadTotals: () =>
        SentryApi.queryEvents({
          fields: ["result", TAG.category, "count()", "count_unique(postId)"],
          query: HealthShared.buildQuery(
            filters,
            `${TELEMETRY_V2} flow:upload`,
          ),
          statsPeriod,
        }),
      photosAttempted: () =>
        SentryApi.queryEvents({
          fields: ["filesInPost", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${TELEMETRY_V2} flow:upload result:started attemptKind:first`,
          ),
          statsPeriod,
        }),
      stuckSnapshots: () =>
        HealthShared.pagedRows({
          fields: ["user.id", "app.device", "timestamp", "stuckOver8h"],
          query: HealthShared.buildQuery(filters, STUCK_SNAPSHOT_QUERY),
          statsPeriod,
          sort: "-timestamp",
        }),

      draftSnapshots: () =>
        HealthShared.pagedRows(
          {
            fields: ["user.id", "app.device", "openDrafts", "last_seen()"],
            query: HealthShared.buildQuery(
              filters,
              `${TELEMETRY_V2} flow:draft result:open`,
            ),
            statsPeriod,
            sort: "-last_seen()",
          },
          PER_PERSON_PAGES,
        ),
      activeReach: () =>
        SentryApi.queryEvents({
          fields: ["count_unique(user)", "count_unique(app.device)"],
          query: HealthShared.buildQuery(
            filters,
            `${TELEMETRY_V2} flow:upload result:started`,
          ),
          statsPeriod,
        }),
      photosLostForever: () =>
        SentryApi.queryEvents({
          fields: ["lostCount", "filesInPost", "count()", "count_unique(user)"],
          query: HealthShared.buildQuery(filters, PHOTOS_LOST_QUERY),
          statsPeriod,
        }),

      photosLostPermanent: () =>
        SentryApi.queryEvents({
          fields: [
            "filesFailed",
            "count()",
            "count_unique(postId)",
            "count_unique(user)",
          ],
          query: HealthShared.buildQuery(
            filters,
            `${UPLOAD_FLOW} result:failure failureCategory:permanent`,
          ),
          statsPeriod,
        }),
      /** Distinct people, ungrouped — grouped rows cannot count people. */
      photosLostPeople: () =>
        SentryApi.queryEvents({
          fields: ["count_unique(user)", "count_unique(postId)"],
          query: HealthShared.buildQuery(
            filters,
            `${UPLOAD_FLOW} result:failure failureCategory:permanent`,
          ),
          statsPeriod,
        }),
      postToServer: () =>
        HealthShared.pagedRows({
          fields: ["totalSecBucket", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${UPLOAD_FLOW} result:success`,
          ),
          statsPeriod,
        }),
      firstTryTotals: () =>
        SentryApi.queryEvents({
          // `attemptKind:first` is the whole point of the attempt counter the
          // app keeps across retries — see § 1.6b of the plan.
          fields: ["result", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${UPLOAD_FLOW} attemptKind:first`,
          ),
          statsPeriod,
        }),
      crashFree: () =>
        SentryApi.querySessions({
          fields: ["crash_free_rate(user)", "count_unique(user)"],
          statsPeriod,
          interval: "1d",
          query: sessionsQuery,
        }),
    });

    const uploadTotals = HealthShared.totalsByResult(
      results.uploadTotals?.rows || [],
    );

    const uploadsMeasured = HealthShared.denominator(uploadTotals) > 0;
    const uploadDenominator = HealthShared.postsAttempted(
      uploadTotals,
      HealthShared.permanentPosts(results.uploadTotals?.rows || []),
    );

    const draftLatest = HealthShared.latestPerKey(
      (results.draftSnapshots?.rows || []).map((row) => ({
        ...row,
        timestamp: row["last_seen()"] ?? row.timestamp,
      })),
      "user.id",
      "app.device",
    );
    const draftsWaiting = draftLatest.reduce(
      (total, row) => total + HealthShared.toNumber(row.openDrafts),
      0,
    );
    const draftsWaitingKnown = draftLatest.length > 0;
    const draftsWaitingAt = draftLatest.reduce<string | null>((newest, row) => {
      const at = String(row.timestamp || "");
      return !newest || at > newest ? at : newest;
    }, null);

    const postToServer = HealthShared.durationStats(
      results.postToServer?.rows || [],
      "totalSecBucket",
    );
    if (results.postToServer?.truncated)
      staleSources.push("postToServer:truncated");

    // Both tiles below are a sum of the LATEST snapshot per person, so a
    // truncated scan silently drops whole people and reads low with no hint
    // that it did. Say so instead — the page shows its "partial data" banner.
    if (results.draftSnapshots?.truncated)
      staleSources.push("draftSnapshots:truncated");
    if (results.stuckSnapshots?.truncated)
      staleSources.push("stuckSnapshots:truncated");

    const firstTryTotals = HealthShared.totalsByResult(
      results.firstTryTotals?.rows || [],
    );
    const firstTryDenominator = HealthShared.postsAttempted(firstTryTotals);

    const stuckLatest = HealthShared.latestPerKey(
      results.stuckSnapshots?.rows || [],
      "user.id",
      "app.device",
    );
    const stuckPosts = stuckLatest.reduce(
      (total, row) => total + HealthShared.toNumber(row.stuckOver8h),
      0,
    );
    const stuckAsOf = stuckLatest.reduce<string | null>((newest, row) => {
      const at = String(row.timestamp || "");
      return !newest || at > newest ? at : newest;
    }, null);

    const photosAttempted = HealthShared.weightedSum(
      results.photosAttempted?.rows || [],
      "filesInPost",
    );

    // Ungrouped, so the single group carries the whole-project rate.
    const crashFreeTotal =
      results.crashFree?.groups?.[0]?.totals?.["crash_free_rate(user)"];
    const crashFreeUsersSeen = HealthShared.toNumber(
      results.crashFree?.groups?.[0]?.totals?.["count_unique(user)"],
    );

    return {
      filters,
      tiles: {
        uploadSuccess: {
          value: HealthShared.rateOrNull(
            uploadTotals.success,
            uploadDenominator,
          ),
          numerator: uploadTotals.success,
          denominator: uploadDenominator,
          note: !uploadsMeasured
            ? NOT_MEASURED_NOTE
            : photosAttempted
              ? `${photosAttempted} photos attempted`
              : undefined,
        },
        crashFreeUsers: {
          value:
            typeof crashFreeTotal === "number"
              ? Math.round(crashFreeTotal * 1000) / 10
              : 0,
          // Note rather than numerator/denominator: the rate counts users while
          // the volume counts sessions, so "x of y" would be two different
          // things either side of the "of".
          note: HealthShared.crashFreeScopeNote(filters, crashFreeUsersSeen),
        },
        stuckPosts: {
          // Same instrumentation release as the upload counters, so if those are
          // silent this zero means "unknown", not "nothing is stuck".
          value: HealthShared.countOrNull(stuckPosts, uploadsMeasured),
          asOf: stuckAsOf || undefined,
          note: uploadsMeasured
            ? "Last snapshot per device — not a live count"
            : NOT_MEASURED_NOTE,
        },
        activeUploaders: {
          value: HealthShared.countOrNull(
            HealthShared.toNumber(
              results.activeReach?.rows?.[0]?.["count_unique(user)"],
            ),
            uploadsMeasured,
          ),
          note: uploadsMeasured
            ? "People who uploaded in this range"
            : NOT_MEASURED_NOTE,
        },
        activeDevices: {
          value: HealthShared.countOrNull(
            HealthShared.toNumber(
              results.activeReach?.rows?.[0]?.["count_unique(app.device)"],
            ),
            uploadsMeasured,
          ),
          note: uploadsMeasured
            ? "Devices that uploaded — not total installs"
            : NOT_MEASURED_NOTE,
        },
        firstTrySuccess: {
          value: HealthShared.rateOrNull(
            firstTryTotals.success,
            firstTryDenominator,
          ),
          numerator: firstTryTotals.success,
          denominator: firstTryDenominator,
          note:
            firstTryDenominator > 0
              ? "Worked without a retry"
              : NOT_MEASURED_NOTE,
        },
        postToServerSeconds: {
          value: postToServer.medianSec,
          note: postToServer.samples
            ? `Typical · mean ${postToServer.meanSec}s across ${postToServer.samples.toLocaleString()} posts`
            : NOT_MEASURED_NOTE,
        },
        draftsWaiting: {
          // One snapshot per person, newest kept — the same shape as stuck posts.
          // Summing every snapshot would count the same phone once per launch.
          value: HealthShared.countOrNull(draftsWaiting, draftsWaitingKnown),
          asOf: draftsWaitingAt || undefined,
          note: draftsWaitingKnown
            ? "Never uploaded — sitting in Drafts"
            : NOT_MEASURED_NOTE,
        },
        photosLostForever: {
          // Weighted by `count_unique(postId)` rather than events — the shared
          // counter prefers it when the query asks for it — so a post that
          // failed three times is one loss, not three.
          value: HealthShared.countOrNull(
            HealthShared.weightedSum(
              results.photosLostPermanent?.rows || [],
              "filesFailed",
            ),
            uploadsMeasured,
          ),
          numerator: HealthShared.lostPeople(
            results.photosLostPeople?.rows || [],
          ),
          // The tiles on the main page come from this summary path, not the
          // detail one — the denominator has to be built in both or the card
          // the user actually looks at silently keeps the old footnote.
          denominator: HealthShared.weightedSum(
            results.photosLostPermanent?.rows || [],
            "filesInPost",
          ),
          footnote: uploadsMeasured
            ? HealthShared.lostFootnote(
                results.photosLostPermanent?.rows || [],
                HealthShared.lostPeople(results.photosLostPeople?.rows || []),
              )
            : undefined,
          note: uploadsMeasured
            ? "Should be zero — alert at one"
            : NOT_MEASURED_NOTE,
        },
      },
      meta: { cachedAt: new Date().toISOString(), staleSources },
    };
  };

  public static getDetail = async (
    filters: IHealthFilters,
  ): Promise<IHealthDetail> => {
    const full = await HealthHelpers.getOverview(filters, { panelsOnly: true });
    return {
      filters: full.filters,
      series: full.series,
      breakdowns: full.breakdowns,
      worst: full.worst,
      meta: full.meta,
    };
  };

  public static getOverview = async (
    filters: IHealthFilters,
    options: { panelsOnly?: boolean } = {},
  ): Promise<IHealthOverview> => {
    const statsPeriod = filters.range;
    // When only the panels are wanted, skip the four queries that exist purely
    // to fill a tile — the summary call has already run them.
    const skipTileOnly = options.panelsOnly === true;
    const noRows = () => Promise.resolve({ rows: [], nextCursor: null });
    const uploadQuery = HealthShared.buildQuery(
      filters,
      `${TELEMETRY_V2} flow:upload`,
    );
    const draftQuery = HealthShared.buildQuery(
      filters,
      `${TELEMETRY_V2} flow:draft`,
    );

    const sessionsQuery = await HealthShared.sessionsFilterQuery(filters);

    const { results, staleSources } = await settleSentryCalls({
      uploadTotals: () =>
        SentryApi.queryEvents({
          fields: ["result", TAG.category, "count()", "count_unique(postId)"],
          query: uploadQuery,
          statsPeriod,
        }),
      // Photos attempted without an event per photo — see the note at the top.
      photosAttempted: () =>
        skipTileOnly
          ? noRows()
          : SentryApi.queryEvents({
              // First attempts only — same reason as the summary path above.
              fields: ["filesInPost", "count()"],
              query: HealthShared.buildQuery(
                filters,
                `${TELEMETRY_V2} flow:upload result:started attemptKind:first`,
              ),
              statsPeriod,
            }),
      uploadByDay: () =>
        HealthShared.pagedRows({
          fields: [
            "timestamp.to_day",
            "result",
            TAG.category,
            "count()",
            "count_unique(postId)",
            "count_unique(user)",
          ],
          query: uploadQuery,
          statsPeriod,
          sort: "timestamp.to_day",
        }),
      draftsByDay: () =>
        HealthShared.pagedRows({
          fields: ["timestamp.to_day", "result", "count()"],
          query: draftQuery,
          statsPeriod,
          sort: "timestamp.to_day",
        }),
      failureReasons: () =>
        SentryApi.queryEvents({
          fields: [
            TAG.category,
            TAG.stage,
            TAG.code,
            "count()",
            "count_unique(postId)",
            "count_unique(user)",
          ],
          query: HealthShared.buildQuery(
            filters,
            `${UPLOAD_FLOW} result:failure`,
          ),
          statsPeriod,
          sort: "-count_unique(postId)",
        }),
      lostByStage: () =>
        SentryApi.queryEvents({
          fields: ["stage", "count()", "count_unique(postId)"],
          query: HealthShared.buildQuery(filters, "flow:upload result:failure"),
          statsPeriod,
          sort: "-count_unique(postId)",
        }),
      timingByNetwork: () =>
        HealthShared.pagedRows({
          fields: [TAG.networkClass, "totalSecBucket", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${UPLOAD_FLOW} result:success`,
          ),
          statsPeriod,
        }),
      timingByConnection: () =>
        HealthShared.pagedRows({
          fields: [TAG.netType, "totalSecBucket", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${UPLOAD_FLOW} result:success`,
          ),
          statsPeriod,
        }),
      byNetwork: () =>
        SentryApi.queryEvents({
          fields: [
            TAG.networkClass,
            "result",
            "count()",
            "count_unique(postId)",
            "count_unique(user)",
          ],
          query: HealthShared.buildQuery(filters, UPLOAD_FLOW),
          statsPeriod,
        }),
      byConnectivity: () =>
        SentryApi.queryEvents({
          fields: [
            TAG.netType,
            "result",
            "count()",
            "count_unique(postId)",
            "count_unique(user)",
          ],
          query: HealthShared.buildQuery(filters, UPLOAD_FLOW),
          statsPeriod,
        }),
      byUser: () =>
        HealthShared.pagedRows(
          {
            fields: [
              "user.id",
              "result",
              "count()",
              "count_unique(postId)",
              "last_seen()",
            ],
            query: uploadQuery,
            statsPeriod,
            sort: "-count_unique(postId)",
          },
          PER_PERSON_PAGES,
        ),
      postCreation: () =>
        SentryApi.queryEvents({
          fields: ["createdOffline", "count()"],
          query: HealthShared.buildQuery(filters, `${TELEMETRY_V2} flow:post`),
          statsPeriod,
        }),
      stuckSnapshots: () =>
        HealthShared.pagedRows({
          fields: [
            "user.id",
            "app.device",
            "timestamp",
            "pendingCount",
            "stuckOver8h",
            "oldestPendingAgeH",
          ],
          query: HealthShared.buildQuery(filters, STUCK_SNAPSHOT_QUERY),
          statsPeriod,
          sort: "-timestamp",
        }),
      // pagedRows, not queryEvents: one page is 100 rows and this groups by
      // person AND device, so on a single page it silently stopped at ~100
      // people and never even flagged itself as truncated.
      draftSnapshots: () =>
        HealthShared.pagedRows(
          {
            fields: ["user.id", "app.device", "openDrafts", "last_seen()"],
            query: HealthShared.buildQuery(
              filters,
              `${TELEMETRY_V2} flow:draft result:open`,
            ),
            statsPeriod,
            sort: "-last_seen()",
          },
          PER_PERSON_PAGES,
        ),
      activeReach: () =>
        skipTileOnly
          ? noRows()
          : SentryApi.queryEvents({
              fields: ["count_unique(user)", "count_unique(app.device)"],
              query: HealthShared.buildQuery(
                filters,
                `${TELEMETRY_V2} flow:upload result:started`,
              ),
              statsPeriod,
            }),
      photosLostForever: () =>
        skipTileOnly
          ? noRows()
          : SentryApi.queryEvents({
              fields: [
                "lostCount",
                "filesInPost",
                "count()",
                "count_unique(user)",
              ],
              query: HealthShared.buildQuery(filters, PHOTOS_LOST_QUERY),
              statsPeriod,
            }),

      /**
       * Photos in posts that failed permanently — the honest "lost forever".
       *
       * NOT the `dataIntegrity.lost` event this tile used to read. That event
       * fires from one place only, `transitionToVerificationFailed`, so it saw
       * photos lost at verification and missed every post that died earlier at
       * sync with the file already gone — four times as many posts, reported
       * nowhere while the tile called itself "lost forever".
       *
       * `filesFailed` is on every failure report in the shipped build, so this
       * needs no app change.
       */
      photosLostPermanent: () =>
        skipTileOnly
          ? noRows()
          : SentryApi.queryEvents({
              fields: [
                "filesFailed",
                "count()",
                "count_unique(postId)",
                "count_unique(user)",
              ],
              query: HealthShared.buildQuery(
                filters,
                `${UPLOAD_FLOW} result:failure failureCategory:permanent`,
              ),
              statsPeriod,
            }),
      /** Distinct people, ungrouped — grouped rows cannot count people. */
      photosLostPeople: () =>
        skipTileOnly
          ? noRows()
          : SentryApi.queryEvents({
              fields: ["count_unique(user)", "count_unique(postId)"],
              query: HealthShared.buildQuery(
                filters,
                `${UPLOAD_FLOW} result:failure failureCategory:permanent`,
              ),
              statsPeriod,
            }),
      // How they were lost, not just how many. Each reason is a different bug:
      // `uploadedNotAttached` means the bytes are still in S3 and recoverable,
      // `localFileGone` means the original left the phone before we had it.
      photosLostByCause: () =>
        skipTileOnly
          ? noRows()
          : SentryApi.queryEvents({
              fields: [
                "lostReason",
                "lostCount",
                "count()",
                "count_unique(postId)",
                "count_unique(user)",
              ],
              query: HealthShared.buildQuery(filters, PHOTOS_LOST_QUERY),
              statsPeriod,
              sort: "-count()",
            }),
      firstTryTotals: () =>
        SentryApi.queryEvents({
          fields: ["result", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${UPLOAD_FLOW} attemptKind:first`,
          ),
          statsPeriod,
        }),
      crashFree: () =>
        SentryApi.querySessions({
          fields: ["crash_free_rate(user)", "count_unique(user)"],
          statsPeriod,
          interval: "1d",
          query: sessionsQuery,
        }),
    });

    const uploadTotals = HealthShared.totalsByResult(
      results.uploadTotals?.rows || [],
    );
    // Volume (attempts) decides "is this measured at all"; the RATE divides by
    // finished uploads, or it can exceed 100% — see HealthShared.postsAttempted.
    const uploadsMeasured = HealthShared.denominator(uploadTotals) > 0;
    const uploadDenominator = HealthShared.postsAttempted(
      uploadTotals,
      HealthShared.permanentPosts(results.uploadTotals?.rows || []),
    );

    const draftLatest = HealthShared.latestPerKey(
      (results.draftSnapshots?.rows || []).map((row) => ({
        ...row,
        timestamp: row["last_seen()"] ?? row.timestamp,
      })),
      "user.id",
      "app.device",
    );
    const draftsWaiting = draftLatest.reduce(
      (total, row) => total + HealthShared.toNumber(row.openDrafts),
      0,
    );
    const draftsWaitingKnown = draftLatest.length > 0;
    const draftsWaitingAt = draftLatest.reduce<string | null>((newest, row) => {
      const at = String(row.timestamp || "");
      return !newest || at > newest ? at : newest;
    }, null);

    const postToServer = HealthShared.durationStats(
      results.timingByNetwork?.rows || [],
      "totalSecBucket",
    );

    const firstTryTotals = HealthShared.totalsByResult(
      results.firstTryTotals?.rows || [],
    );
    const firstTryDenominator = HealthShared.postsAttempted(firstTryTotals);

    const stuckRows = results.stuckSnapshots?.rows || [];
    const stuckLatest = HealthShared.latestPerKey(
      stuckRows,
      "user.id",
      "app.device",
    );
    const stuckPosts = stuckLatest.reduce(
      (total, row) => total + HealthShared.toNumber(row.stuckOver8h),
      0,
    );
    const stuckAsOf = stuckLatest.reduce<string | null>((newest, row) => {
      const at = String(row.timestamp || "");
      return !newest || at > newest ? at : newest;
    }, null);

    // No silent caps. This used to guess from `rows.length >= 100`, which was
    // both a guess and wrong once the query paginated — `pagedRows` reports it.
    if (results.stuckSnapshots?.truncated)
      staleSources.push("stuckSnapshots:truncated");

    // Grouped by day AND result, so the row count is days x outcomes: at 90 days
    // that is ~270 rows and one page holds 100. Unpaginated, the charts quietly
    // lost two thirds of the window at the widest range.
    if (results.uploadByDay?.truncated)
      staleSources.push("uploadByDay:truncated");
    if (results.draftsByDay?.truncated)
      staleSources.push("draftsByDay:truncated");
    // One row per person per outcome — grows with the fleet, not the range.
    if (results.byUser?.truncated) staleSources.push("byUser:truncated");
    // Newly pageable, so it can now say when it stopped early — before this it
    // was a single 100-row page that truncated in silence.
    if (results.draftSnapshots?.truncated)
      staleSources.push("draftSnapshots:truncated");

    const postRows = results.postCreation?.rows || [];
    const postsTotal = postRows.reduce(
      (total, row) => total + HealthShared.count(row),
      0,
    );
    const postsOffline = postRows
      .filter((row) => String(row.createdOffline) === "true")
      .reduce((total, row) => total + HealthShared.count(row), 0);

    const userRows = results.byUser?.rows || [];
    const userPivot = HealthShared.pivotByResult(userRows, "user.id");
    const rankedUsers = Array.from(userPivot.entries())
      .map(([userId, counts]) => {
        const started = HealthShared.denominator(counts);
        const meta = userRows.find(
          (row) => String(row["user.id"] || "") === userId,
        );
        return {
          userId,
          started,
          success: counts.success,
          failed: counts.failure,
          successRate: HealthShared.rate(
            counts.success,
            HealthShared.postsAttempted(counts),
          ),
          lastSeenAt: HealthShared.isoOrNull(meta?.["last_seen()"] ?? null),
        };
      })
      .filter((row) => row.started > 0)
      .sort((first, second) => first.successRate - second.successRate)
      .slice(0, WORST_LIMIT);

    // One name lookup and one active-days pass for the whole page.
    const [names, activeDayResult] = await Promise.all([
      HealthUsers.resolveUserNames(rankedUsers.map((user) => user.userId)),
      HealthUsers.getActiveDaysForUsers(
        filters,
        rankedUsers.map((user) => user.userId),
      ),
    ]);
    if (activeDayResult.truncated) staleSources.push("activeDays:truncated");

    const worstUsers: IWorstUser[] = rankedUsers.map((user) => {
      // Divide by days this person actually uploaded on, not by days in the
      // range — 70 uploads on one day reads as 70/day, not 5/day.
      const activeDays = activeDayResult.activeDays.get(user.userId) ?? 0;
      const perDay = activeDays > 0 ? user.started / activeDays : 0;
      return {
        ...user,
        name: names.get(user.userId)?.name || null,
        companyName: names.get(user.userId)?.companyName || null,
        activeDays,
        uploadsPerActiveDay: Math.round(perDay * 10) / 10,
      };
    });

    const networkTiming = HealthShared.durationStatsByKey(
      results.timingByNetwork?.rows || [],
      TAG.networkClass,
      "totalSecBucket",
    );
    const connectionTiming = HealthShared.durationStatsByKey(
      results.timingByConnection?.rows || [],
      TAG.netType,
      "totalSecBucket",
    );
    if (results.timingByNetwork?.truncated) {
      staleSources.push("timingByNetwork:truncated");
    }
    if (results.timingByConnection?.truncated) {
      staleSources.push("timingByConnection:truncated");
    }

    // Ungrouped, so the single group carries the whole-project rate.
    const crashFreeTotal =
      results.crashFree?.groups?.[0]?.totals?.["crash_free_rate(user)"];
    const crashFreeUsersSeen = HealthShared.toNumber(
      results.crashFree?.groups?.[0]?.totals?.["count_unique(user)"],
    );

    const uploadDays = HealthShared.seriesByDay(
      results.uploadByDay?.rows || [],
      // `failure` too: the chart's rate has to divide by finished uploads, and
      // without it the only available divisor was `started`, which produced
      // 150% on days where uploads finished that had begun the day before.
      ["started", "success", "failure"],
    );
    const draftDays = HealthShared.seriesByDay(
      results.draftsByDay?.rows || [],
      ["created", "posted", "discarded"],
    );

    const photosAttempted = HealthShared.weightedSum(
      results.photosAttempted?.rows || [],
      "filesInPost",
    );

    // Unique uploaders per day comes from the same grouped query, keyed by day.
    const uniqueUsersByDay = new Map<string, number>();
    for (const row of results.uploadByDay?.rows || []) {
      const day = String(row["timestamp.to_day"] || "");
      if (!day) continue;
      uniqueUsersByDay.set(
        day,
        Math.max(
          uniqueUsersByDay.get(day) ?? 0,
          HealthShared.toNumber(row["count_unique(user)"]),
        ),
      );
    }

    const uploadRows = results.uploadByDay?.rows || [];
    const permanentByDay = HealthShared.categoryByDay(
      uploadRows,
      FAILURE_CATEGORY.permanent,
    );
    const transientByDay = HealthShared.categoryByDay(
      uploadRows,
      FAILURE_CATEGORY.transient,
    );

    const uploadDaySeries: IUploadDayPoint[] = uploadDays.map(
      ({ day, counts }) => {
        const started = counts.started || 0;
        const success = counts.success || 0;
        const split = HealthShared.splitDay({
          started,
          success,
          permanent: permanentByDay.get(day) ?? 0,
          transient: transientByDay.get(day) ?? 0,
        });
        return {
          day,
          started,
          success,
          failure: counts.failure || 0,
          permanent: split.permanent,
          retrying: split.retrying,
          inProgress: split.inProgress,
          uniqueUsers: uniqueUsersByDay.get(day) ?? 0,
        };
      },
    );

    return {
      filters,
      tiles: {
        uploadSuccess: {
          value: HealthShared.rateOrNull(
            uploadTotals.success,
            uploadDenominator,
          ),
          numerator: uploadTotals.success,
          denominator: uploadDenominator,
          note: !uploadsMeasured
            ? NOT_MEASURED_NOTE
            : photosAttempted
              ? `${photosAttempted} photos attempted`
              : undefined,
        },
        crashFreeUsers: {
          value:
            typeof crashFreeTotal === "number"
              ? Math.round(crashFreeTotal * 1000) / 10
              : null,
          note: HealthShared.crashFreeScopeNote(filters, crashFreeUsersSeen),
        },
        stuckPosts: {
          value: HealthShared.countOrNull(stuckPosts, uploadsMeasured),
          asOf: stuckAsOf || undefined,
          note: uploadsMeasured
            ? "Last snapshot per device — not a live count"
            : NOT_MEASURED_NOTE,
        },
        activeUploaders: {
          value: HealthShared.countOrNull(
            HealthShared.toNumber(
              results.activeReach?.rows?.[0]?.["count_unique(user)"],
            ),
            uploadsMeasured,
          ),
          note: uploadsMeasured
            ? "People who uploaded in this range"
            : NOT_MEASURED_NOTE,
        },
        activeDevices: {
          value: HealthShared.countOrNull(
            HealthShared.toNumber(
              results.activeReach?.rows?.[0]?.["count_unique(app.device)"],
            ),
            uploadsMeasured,
          ),
          note: uploadsMeasured
            ? "Devices that uploaded — not total installs"
            : NOT_MEASURED_NOTE,
        },
        firstTrySuccess: {
          value: HealthShared.rateOrNull(
            firstTryTotals.success,
            firstTryDenominator,
          ),
          numerator: firstTryTotals.success,
          denominator: firstTryDenominator,
          note:
            firstTryDenominator > 0
              ? "Worked without a retry"
              : NOT_MEASURED_NOTE,
        },
        postToServerSeconds: {
          value: postToServer.medianSec,
          note: postToServer.samples
            ? `Typical · mean ${postToServer.meanSec}s across ${postToServer.samples.toLocaleString()} posts`
            : NOT_MEASURED_NOTE,
        },
        draftsWaiting: {
          value: HealthShared.countOrNull(draftsWaiting, draftsWaitingKnown),
          asOf: draftsWaitingAt || undefined,
          note: draftsWaitingKnown
            ? "Never uploaded — sitting in Drafts"
            : NOT_MEASURED_NOTE,
        },
        photosLostForever: {
          // Weighted by `count_unique(postId)` rather than events — the shared
          // counter prefers it when the query asks for it — so a post that
          // failed three times is one loss, not three.
          value: HealthShared.countOrNull(
            HealthShared.weightedSum(
              results.photosLostPermanent?.rows || [],
              "filesFailed",
            ),
            uploadsMeasured,
          ),
          numerator: HealthShared.lostPeople(
            results.photosLostPeople?.rows || [],
          ),
          // Photos in the posts that lost something. "3 lost" is a very
          // different problem when the post held 3 photos than when it held 40.
          denominator: HealthShared.weightedSum(
            results.photosLostPermanent?.rows || [],
            "filesInPost",
          ),
          footnote: uploadsMeasured
            ? HealthShared.lostFootnote(
                results.photosLostPermanent?.rows || [],
                HealthShared.lostPeople(results.photosLostPeople?.rows || []),
              )
            : undefined,
          note: uploadsMeasured
            ? "Should be zero — alert at one"
            : NOT_MEASURED_NOTE,
        },
      },
      series: {
        uploadSuccessByDay: uploadDaySeries,
        draftsByDay: draftDays.map(({ day, counts }) => ({
          day,
          created: counts.created || 0,
          posted: counts.posted || 0,
          discarded: counts.discarded || 0,
        })),
      },
      breakdowns: {
        photosLostByCause: (results.photosLostByCause?.rows || []).map(
          (row) => ({
            reason: String(row.lostReason || "unknown"),
            photos:
              HealthShared.toNumber(row.lostCount) * HealthShared.attempts(row),
            posts: HealthShared.toNumber(row["count_unique(postId)"]),
            users: HealthShared.toNumber(row["count_unique(user)"]),
          }),
        ),
        failuresByStage: (results.lostByStage?.rows || []).map((row) => ({
          stage: String(row.stage || "unknown"),
          posts: HealthShared.count(row),
        })),
        failureReasons: HealthShared.toFailureReasons(
          results.failureReasons?.rows || [],
        ),
        byNetwork: HealthShared.toResultSplit(
          results.byNetwork?.rows || [],
          TAG.networkClass,
        ).map(({ key, ...rest }) => ({
          networkClass: key,
          ...rest,
          ...HealthShared.timingFor(networkTiming, key),
        })),
        byConnectivity: HealthShared.toResultSplit(
          results.byConnectivity?.rows || [],
          TAG.netType,
        ).map(({ key, ...rest }) => ({
          connectivity: key,
          ...rest,
          ...HealthShared.timingFor(connectionTiming, key),
        })),
        stuckByAge: HealthShared.bucketAges(
          stuckLatest.map((row) =>
            HealthShared.toNumber(row.oldestPendingAgeH),
          ),
        ),
        postCreation: {
          total: postsTotal,
          createdOffline: postsOffline,
          createdOfflineShare: HealthShared.rate(postsOffline, postsTotal),
          neverReachedUpload: Math.max(0, postsTotal - uploadTotals.started),
        },
      },
      worst: { users: worstUsers },
      meta: { cachedAt: new Date().toISOString(), staleSources },
    };
  };
}
