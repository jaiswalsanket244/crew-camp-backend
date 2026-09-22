import axios from "axios";
import { config } from "../utils/configuration/config";
import {
  ISentryEventRow,
  ISentryEventsQuery,
  ISentryEventsResult,
  ISentrySessionsQuery,
  ISentrySessionsResult,
} from "../utils/interfaces/health";

const SENTRY_BASE_URL = "https://sentry.io/api/0";

export const SENTRY_MAX_PER_PAGE = 100;

export class SentryApiError extends Error {
  public readonly status: number;
  public readonly isRateLimited: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SentryApiError";
    this.status = status;
    this.isRateLimited = status === 429;
  }
}

export class SentryNotConfiguredError extends Error {
  constructor() {
    super(
      "Sentry is not configured (SENTRY_ORG_SLUG / SENTRY_PROJECT_ID / SENTRY_ORG_TOKEN)",
    );
    this.name = "SentryNotConfiguredError";
  }
}

export const isSentryConfigured = (): boolean => {
  return Boolean(
    config.SENTRY_ORG_SLUG &&
    config.SENTRY_PROJECT_ID &&
    config.SENTRY_ORG_TOKEN,
  );
};

const parseNextCursor = (linkHeader: string | undefined): string | null => {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    if (!part.includes('rel="next"')) continue;
    if (part.includes('results="false"')) return null;

    const match = /cursor="([^"]+)"/.exec(part);
    return match ? match[1] : null;
  }

  return null;
};

export class SentryApi {
  private static request = async <T>(
    path: string,
    params: Record<string, string | string[]>,
  ): Promise<{ payload: T; nextCursor: string | null }> => {
    if (!isSentryConfigured()) {
      throw new SentryNotConfiguredError();
    }

    // ── One retry, for transient failures only
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await SentryApi.requestOnce<T>(path, params);
      } catch (error) {
        lastError = error;
        const status: number = (error as SentryApiError)?.status || 0;
        const isTimeout = (error as Error)?.message?.includes("timeout");
        const retryable = isTimeout || status === 429 || status >= 500;
        if (!retryable || attempt === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    throw lastError;
  };

  private static requestOnce = async <T>(
    path: string,
    params: Record<string, string | string[]>,
  ): Promise<{ payload: T; nextCursor: string | null }> => {
    try {
      const response = await axios.get<T>(`${SENTRY_BASE_URL}${path}`, {
        params,
        headers: {
          Authorization: `Bearer ${config.SENTRY_ORG_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
        paramsSerializer: {
          indexes: null, // repeat keys: field=a&field=b, which Sentry expects
        },
      });

      return {
        payload: response.data,
        nextCursor: parseNextCursor(response.headers?.link as string),
      };
    } catch (error) {
      const status: number = error?.response?.status || 500;
      const detail: string =
        error?.response?.data?.detail || error?.message || "unknown error";
      throw new SentryApiError(`Sentry ${path} failed: ${detail}`, status);
    }
  };

  /**
   * Table query over the events dataset — the workhorse behind nearly every
   * widget. Grouping is implicit: any non-aggregate field becomes a group key.
   */
  public static queryEvents = async (
    options: ISentryEventsQuery,
  ): Promise<ISentryEventsResult> => {
    const params: Record<string, string | string[]> = {
      field: options.fields.slice(0, 20),
      query: options.query,
      statsPeriod: options.statsPeriod,
      project: config.SENTRY_PROJECT_ID,
      dataset: options.dataset || "errors",
      per_page: String(
        Math.min(options.perPage || SENTRY_MAX_PER_PAGE, SENTRY_MAX_PER_PAGE),
      ),
    };

    if (options.sort) params.sort = options.sort;
    if (options.cursor) params.cursor = options.cursor;

    const { payload, nextCursor } = await SentryApi.request<{
      data: ISentryEventRow[];
    }>(`/organizations/${config.SENTRY_ORG_SLUG}/events/`, params);

    return { rows: payload?.data || [], nextCursor };
  };

  public static querySessions = async (
    options: ISentrySessionsQuery,
  ): Promise<ISentrySessionsResult> => {
    const params: Record<string, string | string[]> = {
      field: options.fields,
      statsPeriod: options.statsPeriod,
      project: config.SENTRY_PROJECT_ID,
      interval: options.interval || "1d",
    };

    if (options.groupBy?.length) params.groupBy = options.groupBy;
    // Was missing: callers passed `query` and it never reached Sentry, so every
    // release filter silently returned the whole-project rate.
    if (options.query) params.query = options.query;

    const { payload } = await SentryApi.request<ISentrySessionsResult>(
      `/organizations/${config.SENTRY_ORG_SLUG}/sessions/`,
      params,
    );

    return {
      intervals: payload?.intervals || [],
      groups: payload?.groups || [],
    };
  };

  public static fetchEvent = async (
    eventId: string,
  ): Promise<Record<string, unknown> | null> => {
    const slug = config.SENTRY_PROJECT_SLUG;
    if (!slug) {
      throw new SentryNotConfiguredError();
    }

    const { payload } = await SentryApi.request<Record<string, unknown>>(
      `/organizations/${config.SENTRY_ORG_SLUG}/events/${slug}:${eventId}/`,
      {},
    );
    return payload || null;
  };

  /** Deep link so an engineer can jump from a dashboard row to the raw events. */
  public static issueSearchUrl = (query: string): string => {
    const params = new URLSearchParams({
      project: config.SENTRY_PROJECT_ID || "",
      query,
    });

    return `https://${config.SENTRY_ORG_SLUG}.sentry.io/issues/?${params.toString()}`;
  };
}

export const SENTRY_MAX_CONCURRENCY = 4;

export const settleSentryCalls = async <
  T extends Record<string, () => Promise<unknown>>,
>(
  calls: T,
): Promise<{
  results: { [K in keyof T]: Awaited<ReturnType<T[K]>> | null };
  staleSources: string[];
}> => {
  const keys = Object.keys(calls) as (keyof T)[];
  const results = {} as { [K in keyof T]: Awaited<ReturnType<T[K]>> | null };
  const staleSources: string[] = [];
  let firstError: Error | null = null;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= keys.length) return;

      const key = keys[index];
      try {
        results[key] = (await calls[key]()) as Awaited<ReturnType<T[keyof T]>>;
      } catch (error) {
        results[key] = null;
        staleSources.push(String(key));
        if (!firstError && error instanceof Error) firstError = error;
        console.warn(
          `[health] Sentry call "${String(key)}" failed:`,
          (error as Error)?.message,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SENTRY_MAX_CONCURRENCY, keys.length) }, () =>
      worker(),
    ),
  );

  if (keys.length > 0 && staleSources.length === keys.length) {
    throw firstError ?? new SentryApiError("Every Sentry query failed", 500);
  }

  return { results, staleSources };
};
