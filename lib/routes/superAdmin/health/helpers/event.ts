import {
  FAILURE_CATEGORY,
  TAG,
  UPLOAD_FLOW,
} from "../../../../constants/health";
import { SentryApi } from "../../../../services/sentryApi";
import {
  ICrashException,
  IUploadAttempt,
  IUploadBreadcrumb,
  IUploadDeviceContext,
  IUploadEventDetail,
  IUploadPostHistory,
} from "../../../../utils/interfaces/health";
import { HealthShared } from "./shared";
import { HealthUsers } from "./users";

const HISTORY_PERIOD = "90d";

const HISTORY_LIMIT = 100;

/**
 * A single upload's detail: timings, breadcrumbs and device context.
 *
 * A leaf area — nothing else in the module calls into it.
 */
export class HealthEvent {
  private static getPostHistory = async (
    postId: string,
  ): Promise<IUploadPostHistory | null> => {
    const { rows } = await SentryApi.queryEvents({
      fields: [
        "id",
        "timestamp",
        "result",
        "attempt",
        TAG.attemptKind,
        TAG.category,
        TAG.stage,
        TAG.code,
        "httpStatus",
        TAG.netType,
        TAG.networkClass,
      ],
      query: `${UPLOAD_FLOW} postId:${HealthShared.quote(postId)}`,
      statsPeriod: HISTORY_PERIOD,
      sort: "-timestamp",
      perPage: HISTORY_LIMIT,
    });

    if (!rows.length) return null;

    const attempts: IUploadAttempt[] = rows.map((row) => ({
      eventId: HealthShared.asString(row.id),
      at: HealthShared.asString(row.timestamp),
      result: String(row.result || "unknown"),
      attempt: HealthShared.asString(row.attempt),
      attemptKind: HealthShared.asString(row[TAG.attemptKind]),
      category: HealthShared.asString(row[TAG.category]),
      stage: HealthShared.asString(row[TAG.stage]),
      reason: HealthShared.asString(row[TAG.code]),
      httpStatus: HealthShared.asString(row.httpStatus),
      connectivity: HealthShared.asString(row[TAG.netType]),
      networkClass: HealthShared.asString(row[TAG.networkClass]),
    }));

    // `started` marks an attempt beginning; success and failure are its
    // outcome. Counting starts rather than outcomes keeps an attempt that is
    // still running from vanishing from the total.
    const starts = attempts.filter((one) => one.result === "started").length;
    const failures = attempts.filter((one) => one.result === "failure");
    const delivered = attempts.some((one) => one.result === "success");
    const newestFailure = failures[0];

    let outcome = "retrying";
    if (delivered) outcome = "uploaded";
    else if (newestFailure?.category === FAILURE_CATEGORY.permanent) {
      outcome = "failed";
    }

    return {
      postId,
      attempts,
      totalAttempts: starts || failures.length,
      failedAttempts: failures.length,
      // Sorted newest first, so the ends of the list are the ends of the story.
      firstAttemptAt: attempts[attempts.length - 1]?.at ?? null,
      lastAttemptAt: attempts[0]?.at ?? null,
      outcome,
      truncated: rows.length >= HISTORY_LIMIT,
    };
  };

  public static getUploadEvent = async (
    eventId: string,
  ): Promise<IUploadEventDetail | null> => {
    const payload = await SentryApi.fetchEvent(eventId);
    if (!payload) return null;

    const raw = payload as {
      eventID?: string;
      groupID?: string;
      dateCreated?: string;
      message?: string;
      title?: string;
      tags?: { key: string; value: string }[];
      context?: Record<string, unknown>;
      contexts?: Record<string, Record<string, unknown>>;
      entries?: { type: string; data?: Record<string, unknown> }[];
    };

    const tags: { [key: string]: string } = {};
    for (const tag of raw.tags || []) {
      if (tag?.key) tags[tag.key] = tag.value;
    }

    const deviceCtx = (raw.contexts?.device || {}) as Record<string, unknown>;
    const osCtx = (raw.contexts?.os || {}) as Record<string, unknown>;
    const extra = (raw.context || {}) as Record<string, unknown>;

    const freeStorage =
      HealthShared.asNumber(deviceCtx.free_storage) ??
      HealthShared.asNumber(extra.freeDiskBytes);
    const totalStorage =
      HealthShared.asNumber(deviceCtx.storage_size) ??
      HealthShared.asNumber(extra.totalDiskBytes);

    const width = HealthShared.asNumber(deviceCtx.screen_width_pixels);
    const height = HealthShared.asNumber(deviceCtx.screen_height_pixels);
    const screen =
      HealthShared.asString(deviceCtx.screen_resolution) ||
      (width && height ? `${width}x${height}` : null);

    const device: IUploadDeviceContext = {
      batteryLevel: HealthShared.asNumber(deviceCtx.battery_level),
      charging: HealthShared.asBool(deviceCtx.charging),
      online: HealthShared.asBool(deviceCtx.online),
      freeMemoryBytes: HealthShared.asNumber(deviceCtx.free_memory),
      totalMemoryBytes: HealthShared.asNumber(deviceCtx.memory_size),
      freeStorageBytes: freeStorage,
      totalStorageBytes: totalStorage,
      screenResolution: screen,
      // Both throttle uploads and both are in every event already.
      lowPowerMode: HealthShared.asBool(deviceCtx.low_power_mode),
      thermalState: HealthShared.asString(deviceCtx.thermal_state),
      model: HealthShared.asString(deviceCtx.model) || tags.device || null,
      deviceClass: tags["device.class"] || null,
      osName: HealthShared.asString(osCtx.name),
      osVersion: HealthShared.asString(osCtx.version),
      osBuild: HealthShared.asString(osCtx.build) || tags["os.build"] || null,
      simulator: HealthShared.asBool(deviceCtx.simulator),
    };

    // Breadcrumbs and exceptions arrive as "entries", each with its own type.
    let breadcrumbs: IUploadBreadcrumb[] = [];
    let hasStackTrace = false;
    let exception: ICrashException | null = null;
    for (const entry of raw.entries || []) {
      if (entry.type === "breadcrumbs") {
        const values = (entry.data?.values || []) as Record<string, unknown>[];
        breadcrumbs = values.map((crumb) => ({
          timestamp: HealthShared.asString(crumb.timestamp),
          category: HealthShared.asString(crumb.category),
          level: HealthShared.asString(crumb.level),
          message: HealthShared.asString(crumb.message),
          data: (crumb.data as { [key: string]: unknown }) || null,
        }));
      }
      if (entry.type === "exception") {
        hasStackTrace = true;
        exception = HealthShared.toCrashException(entry.data);
      }
    }

    const userId = tags["user"] || tags["user.id"] || null;
    const resolved = userId
      ? await HealthUsers.resolveUserNames([userId.replace(/^id:/, "")])
      : null;
    const identity = userId
      ? resolved?.get(userId.replace(/^id:/, "")) || null
      : null;

    const postId =
      HealthShared.asString(tags.postId) || HealthShared.asString(extra.postId);
    const history = postId
      ? await HealthEvent.getPostHistory(postId).catch(() => null)
      : null;

    return {
      eventId: raw.eventID || eventId,
      groupId: HealthShared.asString(raw.groupID),
      at: HealthShared.asString(raw.dateCreated),
      message:
        HealthShared.asString(raw.message) || HealthShared.asString(raw.title),
      level: tags.level || null,
      tags,
      extra,
      device,
      exception,
      user: {
        id: userId,
        name: identity?.name || null,
        companyName: identity?.companyName || null,
      },
      breadcrumbs,
      hasStackTrace,
      history,
      sentryUrl: SentryApi.issueSearchUrl(`id:${eventId}`),
    };
  };
}
