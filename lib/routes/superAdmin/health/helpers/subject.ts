import {
  STUCK_SNAPSHOT_QUERY,
  PHOTOS_LOST_QUERY,
  SUBJECT_FIELD,
  TAG,
  TELEMETRY_V2,
  UPLOAD_FLOW,
  FAILURE_CATEGORY,
} from "../../../../constants/health";
import { Company, CompanyMember } from "../../../../db";
import { SentryApi, settleSentryCalls } from "../../../../services/sentryApi";
import {
  IHealthFilters,
  IHealthSubject,
  ISubjectEvent,
} from "../../../../utils/interfaces/health";
import { HealthShared } from "./shared";
import { HealthUsers } from "./users";

export class HealthSubject {
  public static getSubject = async (
    filters: IHealthFilters,
    type: string,
    id: string,
  ): Promise<IHealthSubject> => {
    const statsPeriod = filters.range;
    const scope = `${SUBJECT_FIELD[type]}:${HealthShared.quote(id)}`;
    const scopedUpload = HealthShared.buildQuery(
      filters,
      `${TELEMETRY_V2} flow:upload`,
      scope,
    );

    const scopedAny = HealthShared.buildQuery(filters, scope);

    const { results, staleSources } = await settleSentryCalls({
      uploadTotals: () =>
        SentryApi.queryEvents({
          fields: ["result", TAG.category, "count()", "count_unique(postId)"],
          query: scopedUpload,
          statsPeriod,
        }),
      fleetUpload: () =>
        SentryApi.queryEvents({
          fields: ["result", TAG.category, "count()", "count_unique(postId)"],
          query: HealthShared.buildQuery(
            filters,
            `${TELEMETRY_V2} flow:upload`,
          ),
          statsPeriod,
        }),
      draftTotals: () =>
        SentryApi.queryEvents({
          fields: ["result", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${TELEMETRY_V2} flow:draft`,
            scope,
          ),
          statsPeriod,
        }),
      // The newest snapshot only. `sort` + `perPage: 1` rather than reducing a
      // page of them: every launch writes one, so the latest is all that counts.
      openDrafts: () =>
        SentryApi.queryEvents({
          fields: ["timestamp", "openDrafts", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${TELEMETRY_V2} flow:draft result:open`,
            scope,
          ),
          statsPeriod,
          sort: "-timestamp",
          perPage: 1,
        }),
      strandedPhotos: () =>
        SentryApi.queryEvents({
          fields: ["photosInDraft", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${TELEMETRY_V2} flow:draft result:discarded`,
            scope,
          ),
          statsPeriod,
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
            scope,
          ),
          statsPeriod,
          sort: "-count_unique(postId)",
        }),
      devices: () =>
        SentryApi.queryEvents({
          fields: [
            "device",
            "os",
            "device.class",
            "os.build",
            "os.rooted",
            "result",
            "count()",
            "count_unique(postId)",
            "last_seen()",
          ],
          query: HealthShared.buildQuery(filters, UPLOAD_FLOW, scope),
          statsPeriod,
          sort: "-count_unique(postId)",
        }),
      connectivityMix: () =>
        SentryApi.queryEvents({
          fields: [
            TAG.netType,
            "result",
            "count()",
            "count_unique(postId)",
            "count_unique(user)",
          ],
          query: HealthShared.buildQuery(filters, UPLOAD_FLOW, scope),
          statsPeriod,
        }),
      networkMix: () =>
        SentryApi.queryEvents({
          fields: [
            TAG.networkClass,
            "result",
            "count()",
            "count_unique(postId)",
            "count_unique(user)",
          ],
          query: HealthShared.buildQuery(filters, UPLOAD_FLOW, scope),
          statsPeriod,
        }),
      // Their current build — the top row of this is "the version they are on",
      // so it reads every event of theirs, not just uploads.
      releases: () =>
        SentryApi.queryEvents({
          fields: ["release", "jsBundle", "count()", "last_seen()"],
          query: scopedAny,
          statsPeriod,
          sort: "-last_seen()",
        }),
      posts: () =>
        SentryApi.queryEvents({
          fields: ["createdOffline", "count()"],
          query: HealthShared.buildQuery(
            filters,
            `${TELEMETRY_V2} flow:post`,
            scope,
          ),
          statsPeriod,
        }),
      photosLost: () =>
        SentryApi.queryEvents({
          fields: ["lostCount", "count()"],
          query: HealthShared.buildQuery(filters, PHOTOS_LOST_QUERY, scope),
          statsPeriod,
        }),
      stuck: () =>
        SentryApi.queryEvents({
          fields: [
            "user.id",
            "timestamp",
            "pendingCount",
            "stuckOver8h",
            "oldestPendingAgeH",
            "oldestCreatedAt",
            "photosPending",
            "connectivity",
            "oldestPostId",
          ],
          query: HealthShared.buildQuery(filters, STUCK_SNAPSHOT_QUERY, scope),
          statsPeriod,
          sort: "-timestamp",
          perPage: 10,
        }),
      uploadByDay: () =>
        SentryApi.queryEvents({
          fields: [
            "timestamp.to_day",
            "result",
            TAG.category,
            "count()",
            "count_unique(postId)",
          ],
          query: HealthShared.buildQuery(filters, UPLOAD_FLOW, scope),
          statsPeriod,
          sort: "timestamp.to_day",
        }),
      recentEvents: () =>
        SentryApi.queryEvents({
          fields: [
            "id",
            "timestamp",
            "result",
            "postId",
            TAG.category,
            TAG.stage,
            TAG.code,
            TAG.netType,
            TAG.networkClass,
            TAG.filesInPost,
            "totalSecBucket",
            // How long the post sat between the person pressing Post and this
            // upload running. A bucket, not a number — the exact ms is an extra
            // and Discover can only project tags.
            "queueWait",
            "device",
          ],
          query: HealthShared.buildQuery(filters, UPLOAD_FLOW, scope),
          statsPeriod,
          sort: "-timestamp",
          perPage: 100,
        }),
      crashes: () =>
        SentryApi.queryEvents({
          fields: ["count()"],
          query: HealthShared.buildQuery(filters, "level:fatal", scope),
          statsPeriod,
        }),
    });

    const subjectUpload = HealthShared.totalsByResult(
      results.uploadTotals?.rows || [],
    );
    const fleetUpload = HealthShared.totalsByResult(
      results.fleetUpload?.rows || [],
    );

    const subjectAttempted = HealthShared.postsAttempted(
      subjectUpload,
      HealthShared.permanentPosts(results.uploadTotals?.rows || []),
    );
    const subjectRate = HealthShared.rateOrNull(
      subjectUpload.success,
      subjectAttempted,
    );
    const fleetRate = HealthShared.rate(
      fleetUpload.success,
      HealthShared.postsAttempted(
        fleetUpload,
        HealthShared.permanentPosts(results.fleetUpload?.rows || []),
      ),
    );

    const draftRows = results.draftTotals?.rows || [];
    const created = HealthShared.countForResult(draftRows, "created");
    const discarded = HealthShared.countForResult(draftRows, "discarded");
    // Newest snapshot only — the same post is re-reported on every launch.
    const latestStuck = HealthShared.latestPerKey(
      results.stuck?.rows || [],
      "user.id",
    )[0];

    const postRows = results.posts?.rows || [];
    const postsCreated = postRows.reduce(
      (total, row) => total + HealthShared.count(row),
      0,
    );
    const postsOffline = postRows
      .filter((row) => String(row.createdOffline) === "true")
      .reduce((total, row) => total + HealthShared.count(row), 0);

    const connectivityRows = results.connectivityMix?.rows || [];
    const networkRows = results.networkMix?.rows || [];

    const openSnapshot = results.openDrafts?.rows?.[0];

    const identity = await HealthSubject.resolveSubjectIdentity(type, id);

    // Hardware detail per handset this person uploaded from. `device.class` is
    // Sentry's own power-class judgement, which is the cheap way to see whether
    // failures cluster on low-end phones without buying a test bench.
    const deviceMap = new Map<
      string,
      {
        model: string;
        os: string;
        deviceClass: string | null;
        osBuild: string | null;
        rooted: string | null;
        started: number;
        success: number;
        failures: number;
        lastSeenAt: string | null;
      }
    >();
    for (const row of results.devices?.rows || []) {
      const model = String(row.device || "unknown");
      const os = String(row.os || "unknown");
      const key = `${model}|${os}`;
      const entry = deviceMap.get(key) || {
        model,
        os,
        deviceClass: row["device.class"] ? String(row["device.class"]) : null,
        osBuild: row["os.build"] ? String(row["os.build"]) : null,
        rooted: row["os.rooted"] ? String(row["os.rooted"]) : null,
        started: 0,
        success: 0,
        failures: 0,
        lastSeenAt: null,
      };
      const count = HealthShared.count(row);
      const result = String(row.result || "");
      if (result === "started") entry.started += count;
      if (result === "success") entry.success += count;
      if (result === "failure") entry.failures += count;

      const seen = HealthShared.isoOrNull(row["last_seen()"] ?? null);
      if (seen && (!entry.lastSeenAt || seen > entry.lastSeenAt)) {
        entry.lastSeenAt = seen;
      }
      deviceMap.set(key, entry);
    }

    // This person's own daily trend, same shape as the fleet chart.
    const subjectRows = results.uploadByDay?.rows || [];
    const subjectPermanentByDay = HealthShared.categoryByDay(
      subjectRows,
      FAILURE_CATEGORY.permanent,
    );
    const subjectTransientByDay = HealthShared.categoryByDay(
      subjectRows,
      FAILURE_CATEGORY.transient,
    );

    const subjectUploadByDay = HealthShared.seriesByDay(subjectRows, [
      "started",
      "success",
      "failure",
    ]).map(({ day, counts }) => {
      const started = counts.started || 0;
      const success = counts.success || 0;
      const split = HealthShared.splitDay({
        started,
        success,
        permanent: subjectPermanentByDay.get(day) ?? 0,
        transient: subjectTransientByDay.get(day) ?? 0,
      });
      return {
        day,
        started,
        success,
        failure: counts.failure || 0,
        permanent: split.permanent,
        retrying: split.retrying,
        inProgress: split.inProgress,
        uniqueUsers: 1,
      };
    });

    const uploadsByPost = new Map<string, ISubjectEvent>();
    const looseEvents: ISubjectEvent[] = [];

    for (const row of results.recentEvents?.rows || []) {
      const result = String(row.result || "unknown");
      const at = String(row.timestamp || "");
      const entry: ISubjectEvent = {
        eventId: row.id ? String(row.id) : null,
        postId: row.postId ? String(row.postId) : null,
        at,
        startedAt: result === "started" ? at : null,
        status: result === "started" ? "inProgress" : result,
        // NOT "failure" as a default — an event whose result we cannot read is
        // unknown, and calling it a failure invented failures that never happened.
        result,
        category: row[TAG.category] ? String(row[TAG.category]) : null,
        stage: row[TAG.stage] ? String(row[TAG.stage]) : null,
        reason: row[TAG.code] ? String(row[TAG.code]) : null,
        connectivity: row[TAG.netType] ? String(row[TAG.netType]) : null,
        networkClass: row[TAG.networkClass]
          ? String(row[TAG.networkClass])
          : null,
        device: row.device ? String(row.device) : null,
        photos: row[TAG.filesInPost]
          ? HealthShared.toNumber(row[TAG.filesInPost])
          : null,
        seconds: row.totalSecBucket
          ? HealthShared.toNumber(row.totalSecBucket)
          : null,
        waited: HealthShared.asString(row.queueWait),
      };

      if (!entry.postId) {
        looseEvents.push(entry);
        continue;
      }

      const existing = uploadsByPost.get(entry.postId);
      if (!existing) {
        uploadsByPost.set(entry.postId, entry);
        continue;
      }

      if (result === "started") {
        if (!existing.startedAt || at < existing.startedAt) {
          existing.startedAt = at;
        }
        continue;
      }

      const existingIsOutcome = existing.status !== "inProgress";
      if (existingIsOutcome && at <= existing.at) continue;

      uploadsByPost.set(entry.postId, {
        ...entry,
        startedAt: existing.startedAt,
      });
    }

    const recentEvents: ISubjectEvent[] = Array.from(uploadsByPost.values())
      .concat(looseEvents)
      .sort((first, second) => (first.at < second.at ? 1 : -1));

    return {
      subject: {
        type: type as IHealthSubject["subject"]["type"],
        id,
        ...identity,
      },
      upload: {
        started: subjectAttempted,
        success: subjectUpload.success,
        failed: subjectUpload.failure,
        successRate: subjectRate,
        vsFleetAverage: HealthShared.pointsVsFleet(subjectRate, fleetRate),
      },
      drafts: {
        created,
        posted: HealthShared.countForResult(draftRows, "posted"),
        discarded,
        // From the snapshot, not the event counts: `created - posted - discarded`
        // looks like the same number but is not, because a draft older than the
        // range contributes to none of them.
        openDrafts: openSnapshot
          ? HealthShared.toNumber(openSnapshot.openDrafts)
          : null,
        openDraftsAt: openSnapshot
          ? HealthShared.isoOrNull(openSnapshot.timestamp ?? null)
          : null,
        oldestOpenHours: null,
        photosStranded: HealthShared.weightedSum(
          results.strandedPhotos?.rows || [],
          "photosInDraft",
        ),
      },
      posts: {
        created: postsCreated,
        createdOffline: postsOffline,
        neverReachedUpload: Math.max(0, postsCreated - subjectUpload.started),
      },
      stuck: {
        asOf: latestStuck ? String(latestStuck.timestamp || "") : null,
        pendingCount: HealthShared.toNumber(latestStuck?.pendingCount),
        stuckOver8h: HealthShared.toNumber(latestStuck?.stuckOver8h),
        oldestAgeH: latestStuck
          ? HealthShared.toNumber(latestStuck.oldestPendingAgeH)
          : null,
        oldestCreatedAt: latestStuck?.oldestCreatedAt
          ? String(latestStuck.oldestCreatedAt)
          : null,
        photosPending: HealthShared.toNumber(latestStuck?.photosPending),
        connectivityAtSnapshot: latestStuck?.connectivity
          ? String(latestStuck.connectivity)
          : null,
        oldestPostId: latestStuck?.oldestPostId
          ? String(latestStuck.oldestPostId)
          : null,
      },
      failureReasons: HealthShared.toFailureReasons(
        results.failureReasons?.rows || [],
      ),
      devices: Array.from(deviceMap.values())
        .map((entry) => ({
          ...entry,
          successRate: HealthShared.rateOrNull(
            entry.success,
            entry.started || entry.success + entry.failures,
          ),
        }))
        .sort((first, second) => second.failures - first.failures),
      connectivityMix: HealthShared.toResultSplit(
        connectivityRows,
        TAG.netType,
      ),
      networkMix: HealthShared.toResultSplit(networkRows, TAG.networkClass),
      // Sorted newest-first, so the first entry is the version they are on now.
      releases: (results.releases?.rows || []).map((row) => ({
        release: String(row.release || "unknown"),
        jsBundle: row.jsBundle ? String(row.jsBundle) : null,
        started: HealthShared.count(row),
        lastSeenAt: HealthShared.isoOrNull(row["last_seen()"] ?? null),
      })),
      uploadByDay: subjectUploadByDay,
      photosLost: HealthShared.weightedSum(
        results.photosLost?.rows || [],
        "lostCount",
      ),
      recentEvents,
      crashes: {
        count: (results.crashes?.rows || []).reduce(
          (total, row) => total + HealthShared.count(row),
          0,
        ),
      },
      sentryUrl: SentryApi.issueSearchUrl(scopedAny),
      meta: { cachedAt: new Date().toISOString(), staleSources },
    };
  };

  private static resolveSubjectIdentity = async (
    type: string,
    id: string,
  ): Promise<{
    name: string | null;
    companyName: string | null;
    role: string | null;
  }> => {
    if (type === "user") {
      const resolved = await HealthUsers.resolveUserNames([id]);
      const entry = resolved.get(id);
      const membership = /^[a-f\d]{24}$/i.test(id)
        ? await CompanyMember.findOne({ userId: id }, { role: 1 }).lean()
        : null;

      return {
        name: entry?.name || null,
        companyName: entry?.companyName || null,
        role: membership?.role || null,
      };
    }

    if (type === "company" && /^[a-f\d]{24}$/i.test(id)) {
      const company = await Company.findById(id, { name: 1 }).lean();
      return {
        name: company?.name || null,
        companyName: company?.name || null,
        role: null,
      };
    }

    // A device model is its own label — nothing to resolve.
    return { name: null, companyName: null, role: null };
  };
}
