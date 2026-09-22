// NPM Dependencies
import * as status from "http-status";
import * as express from "express";
import { Validator } from "node-input-validator";

// Internal Dependencies
import { HealthHelpers } from "./helpers";
import { HealthCamera } from "./helpers/camera";
import { HealthEvent } from "./helpers/event";
import { HealthBreakdown } from "./helpers/breakdown";
import { HealthSubject } from "./helpers/subject";
import { HealthCrashes } from "./helpers/crashes";
import { HealthUsers } from "./helpers/users";
import { HealthStuck } from "./helpers/stuck";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../../utils/helpers/apiResponse";
import { cacheService } from "../../../services/redis";
import { CacheTTL } from "../../../utils/interfaces/cache";
import {
  SentryApiError,
  SentryNotConfiguredError,
  SENTRY_MAX_PER_PAGE,
} from "../../../services/sentryApi";
import {
  HealthDimension,
  HealthMetric,
  IHealthFilters,
} from "../../../utils/interfaces/health";
import {
  CACHE_PREFIX,
  CACHE_TTL,
  DIMENSIONS,
  METRICS,
  PLATFORMS,
  RANGES,
  SCOPES,
  SUBJECT_TYPES,
} from "../../../constants/health";

export class HealthRoutes {
  private static parseFilters = (query: {
    [key: string]: string;
  }): IHealthFilters => {
    return {
      range: (RANGES.includes(query.range)
        ? query.range
        : "14d") as IHealthFilters["range"],
      platform: (PLATFORMS.includes(query.platform)
        ? query.platform
        : "all") as IHealthFilters["platform"],
      release: query.release || undefined,
      network:
        query.network && query.network !== "all" ? query.network : undefined,
      connectivity:
        query.connectivity && query.connectivity !== "all"
          ? query.connectivity
          : undefined,
      company: query.company || undefined,
      jsBundle: query.jsBundle || undefined,
      failureCode: query.failureCode || undefined,
      failureStage: query.failureStage || undefined,
    };
  };

  private static cachedIfClean = async <
    T extends { meta: { staleSources: string[] } },
  >(
    key: string,
    ttl: number,
    produce: () => Promise<T>,
  ): Promise<T> => {
    const cached = await cacheService.get<T>(key, CACHE_PREFIX);
    if (cached) return cached;

    const fresh = await produce();
    if (fresh.meta.staleSources.length === 0) {
      await cacheService.set(key, fresh, { ttl, prefix: CACHE_PREFIX });
    }
    return fresh;
  };

  /** Cache key must include every filter, or two filtered views collide. */
  private static cacheKey = (
    scope: string,
    filters: IHealthFilters,
    extra: string[] = [],
  ): string => {
    return [
      scope,
      filters.range,
      filters.platform,
      filters.release || "-",
      filters.network || "-",
      filters.connectivity || "-",
      filters.company || "-",
      filters.jsBundle || "-",
      // Must be here even though only the people list reads them: without it a
      // filtered request and an unfiltered one share a key, so "See people" on
      // a failure reason served the cached list of everybody.
      filters.failureCode || "-",
      filters.failureStage || "-",
      ...extra,
    ].join(":");
  };

  /**
   * 503 rather than 500 when Sentry credentials are absent: the code is fine,
   * the deployment is missing config. Distinguishing the two saves a debugging
   * hour. A rate-limit is surfaced as 429 so the UI can back off.
   */
  private static handleError = (
    error: unknown,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (error instanceof SentryNotConfiguredError) {
      return ErrorResponse(res, status.SERVICE_UNAVAILABLE, {
        message: error.message,
      });
    }

    if (error instanceof SentryApiError && error.isRateLimited) {
      return ErrorResponse(res, status.TOO_MANY_REQUESTS, {
        message: "Sentry rate limit reached, try again shortly.",
      });
    }

    if (error instanceof SentryApiError) {
      // Surface Sentry's own status rather than a blanket 500: 401/403 means the
      // org token is missing scopes, 404 means the org or project slug is wrong.
      if (error.status === 401 || error.status === 403) {
        return ErrorResponse(res, status.SERVICE_UNAVAILABLE, {
          message:
            "Sentry rejected the org token — check it has org:read, project:read and event:read.",
        });
      }
      if (error.status === 404) {
        return ErrorResponse(res, status.SERVICE_UNAVAILABLE, {
          message:
            "Sentry could not find the org or project — check SENTRY_ORG_SLUG and SENTRY_PROJECT_ID.",
        });
      }
      return ErrorResponse(res, status.BAD_GATEWAY, { message: error.message });
    }

    return next(error);
  };

  /**
   * Drop every cached health response, so the next read recomputes.
   *
   * Every panel is cached for minutes at a time, which is right for normal use
   * and wrong when someone has just deployed a fix and needs to see whether it
   * worked. Clearing beats a per-request `fresh` flag: that would have to be
   * threaded through fourteen call sites and could be left on by accident,
   * turning the cache off for everyone.
   */
  public static refreshCache = async (
    _req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const cleared = await cacheService.deleteByPrefix(CACHE_PREFIX);

      if (cleared === null) {
        // Not an error: with no Redis there is nothing cached, so the next read
        // is already fresh. Saying so beats reporting a failure.
        return SuccessResponse(res, status.OK, {
          message: "No cache to clear — responses are already live.",
          data: { cleared: 0, cacheAvailable: false },
        });
      }

      return SuccessResponse(res, status.OK, {
        message: `Cleared ${cleared} cached response${cleared === 1 ? "" : "s"}.`,
        data: { cleared, cacheAvailable: true },
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  public static overview = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        scope: `in:${SCOPES.join(",")}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);

      // The page asks for `summary` first so the tiles render off 7 queries,
      // then `detail` for the panels. `all` stays available for anything that
      // wants the whole payload in one go.
      const scope: string = SCOPES.includes(req.query.scope)
        ? req.query.scope
        : "all";

      const produce = (): Promise<{ meta: { staleSources: string[] } }> => {
        if (scope === "summary") return HealthHelpers.getSummary(filters);
        if (scope === "detail") return HealthHelpers.getDetail(filters);
        return HealthHelpers.getOverview(filters);
      };

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("overview", filters, [scope]),
        CACHE_TTL.overview,
        produce,
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /**
   * Releases seen in the range, per platform, newest first — feeds the version
   * filter. Deliberately NOT scoped by `release`, since the point is to list
   * the options.
   */
  public static releases = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters({
        ...req.query,
        release: "",
      });

      const data = await cacheService.getOrSet(
        HealthRoutes.cacheKey("releases", filters),
        () => HealthUsers.getReleases(filters),
        { ttl: CACHE_TTL.releases, prefix: CACHE_PREFIX },
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /**
   * Every user who uploaded in the range, ranked worst-first. `search` matches
   * name or email through our own database first — Sentry only holds ids.
   */
  public static users = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        search: "string|maxLength:120",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const search: string = (req.query.search || "").trim();

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("users", filters, [search || "-"]),
        CACHE_TTL.breakdown,
        () => HealthUsers.getUserUploadList(filters, search || undefined),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /**
   * One upload attempt in full — tags, extras, device conditions and the
   * breadcrumb trail. Cached hard: an event never changes once written.
   */
  public static event = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        id: "required|string|maxLength:64",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const eventId: string = String(req.query.id);
      const data = await cacheService.getOrSet(
        `event:${eventId}`,
        () => HealthEvent.getUploadEvent(eventId),
        { ttl: CacheTTL.MEDIUM, prefix: CACHE_PREFIX },
      );

      if (!data) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message:
            "Event not found — it may have passed Sentry's retention window.",
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /** Handsets with camera trouble. Cursor-paginated, like the crash list. */
  public static cameraDevices = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        limit: `integer|min:1|max:${SENTRY_MAX_PER_PAGE}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const limit = Math.min(
        Number(req.query.limit) || 10,
        SENTRY_MAX_PER_PAGE,
      );
      const cursor: string = req.query.cursor || "";

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("cameraDevices", filters, [
          String(limit),
          cursor || "-",
        ]),
        CACHE_TTL.breakdown,
        () =>
          HealthCamera.getCameraIssueDevices(
            filters,
            limit,
            cursor || undefined,
          ),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /** Every camera issue on one handset model. */
  public static cameraDeviceIssues = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        device: "required|string|maxLength:120",
        os: "required|string|maxLength:120",
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        limit: `integer|min:1|max:${SENTRY_MAX_PER_PAGE}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const device: string = String(req.query.device);
      const os: string = String(req.query.os);
      const limit = Math.min(
        Number(req.query.limit) || 10,
        SENTRY_MAX_PER_PAGE,
      );
      const cursor: string = req.query.cursor || "";

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("cameraDeviceIssues", filters, [
          device,
          os,
          String(limit),
          cursor || "-",
        ]),
        CACHE_TTL.subject,
        () =>
          HealthCamera.getCameraDeviceIssues(
            filters,
            device,
            os,
            limit,
            cursor || undefined,
          ),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /** Camera capture report. Honours the whole filter row. */
  public static camera = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("camera", filters),
        CACHE_TTL.overview,
        () => HealthCamera.getCameraReport(filters),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /**
   * Crash-free users per release, for one platform.
   *
   * Its own endpoint because the card carries its own filters: it compares
   * builds, so the page's version filter must not reach it.
   */
  public static crashFree = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      // `release` stripped on the way in, so a cached key cannot vary by it.
      const filters = HealthRoutes.parseFilters({
        ...req.query,
        release: "",
      });

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("crashFree", filters),
        CACHE_TTL.overview,
        () => HealthCrashes.getCrashFreeByRelease(filters),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /**
   * Handsets that crashed in the range. Cursor-paginated: page two is the next
   * ten handsets, not a slice of a list we already downloaded.
   */
  public static crashedDevices = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        limit: `integer|min:1|max:${SENTRY_MAX_PER_PAGE}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const limit = Math.min(
        Number(req.query.limit) || 10,
        SENTRY_MAX_PER_PAGE,
      );
      const cursor: string = req.query.cursor || "";

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("crashedDevices", filters, [
          String(limit),
          cursor || "-",
        ]),
        CACHE_TTL.breakdown,
        () =>
          HealthCrashes.getCrashedDevices(filters, limit, cursor || undefined),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  /** Every crash on one handset model. */
  /**
   * How far one crash reached — device and people breakdown for a single issue.
   *
   * Takes the group id rather than an event id: the question is about the crash,
   * not one occurrence of it, and the detail page already knows its group.
   */
  public static crashImpact = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        issueId: "required|string|maxLength:32|regex:^[0-9]+$",
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        limit: "integer|min:1|max:25",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const issueId: string = String(req.query.issueId);
      const limit = Math.min(Number(req.query.limit) || 5, 25);

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("crashImpact", filters, [issueId, String(limit)]),
        CACHE_TTL.subject,
        () => HealthCrashes.getCrashImpact(filters, issueId, limit),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  public static deviceCrashes = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        device: "required|string|maxLength:120",
        os: "required|string|maxLength:120",
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        limit: `integer|min:1|max:${SENTRY_MAX_PER_PAGE}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const device: string = String(req.query.device);
      const os: string = String(req.query.os);
      const limit = Math.min(
        Number(req.query.limit) || 25,
        SENTRY_MAX_PER_PAGE,
      );
      const cursor: string = req.query.cursor || "";

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("deviceCrashes", filters, [
          device,
          os,
          String(limit),
          cursor || "-",
        ]),
        CACHE_TTL.subject,
        () =>
          HealthCrashes.getDeviceCrashes(
            filters,
            device,
            os,
            limit,
            cursor || undefined,
          ),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  public static breakdown = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        dimension: `required|in:${DIMENSIONS.join(",")}`,
        metric: `in:${METRICS.join(",")}`,
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        limit: `integer|min:1|max:${SENTRY_MAX_PER_PAGE}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const dimension = req.query.dimension as HealthDimension;
      const metric = (
        METRICS.includes(req.query.metric) ? req.query.metric : "upload"
      ) as HealthMetric;
      const limit = Math.min(
        Number(req.query.limit) || 50,
        SENTRY_MAX_PER_PAGE,
      );
      const cursor: string = req.query.cursor || "";

      // `cachedIfClean`, not `getOrSet` — this endpoint was the one place still
      // able to pin a half-failed response for the whole TTL.
      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("breakdown", filters, [
          dimension,
          metric,
          String(limit),
          cursor || "-",
        ]),
        CACHE_TTL.breakdown,
        () =>
          HealthBreakdown.getBreakdown(
            filters,
            dimension,
            metric,
            limit,
            cursor || undefined,
          ),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  public static subject = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        type: `required|in:${SUBJECT_TYPES.join(",")}`,
        id: "required|string",
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const { type, id } = req.query;

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("subject", filters, [type, id]),
        CACHE_TTL.subject,
        () => HealthSubject.getSubject(filters, type, id),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };

  public static stuckUploads = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        range: `in:${RANGES.join(",")}`,
        platform: `in:${PLATFORMS.join(",")}`,
        limit: `integer|min:1|max:${SENTRY_MAX_PER_PAGE}`,
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const filters = HealthRoutes.parseFilters(req.query);
      const limit = Math.min(
        Number(req.query.limit) || 50,
        SENTRY_MAX_PER_PAGE,
      );
      const cursor: string = req.query.cursor || "";

      const data = await HealthRoutes.cachedIfClean(
        HealthRoutes.cacheKey("stuckUploads", filters, [
          String(limit),
          cursor || "-",
        ]),
        CACHE_TTL.breakdown,
        () => HealthStuck.getStuckUploads(filters, limit, cursor || undefined),
      );

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      return HealthRoutes.handleError(error, res, next);
    }
  };
}
