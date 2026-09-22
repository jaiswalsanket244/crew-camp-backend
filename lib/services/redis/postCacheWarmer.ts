import { cacheService } from "./cacheService";
import { redisService } from "./redisClient";
import { REDIS_GRID_POSTS_CACHE_COMPANY_IDS } from "../../utils/constants/constants";
import { CacheTTL } from "../../utils/interfaces/cache";

// Cache warmer: replaces "delete on invalidate" with "re-fetch and overwrite".
// Reads during the warm window see the previous-revision value (atomic SET
// swap in Redis), so users never hit a cold cache — only stale-by-one-revision
// for the few seconds the aggregation takes to run.
//
// To avoid a circular import between this module and posts/helper.ts, we use
// a registration pattern: cacheWarmerSetup.ts (loaded by both the main server
// and the cron entry point) calls registerCacheRefresh once per view at boot.

const TRACKER_PREFIX = "posts-cache-tracker";
// Tracker is kept slightly longer than the 24-hour cache TTL so cron has a
// record of every active key even if it hasn't been touched in a while.
const TRACKER_TTL = 7 * 24 * 60 * 60; // 7 days

// Only the first few pages get re-warmed after a mutation. Real hit rates
// concentrate on pages 1-3; warming all 20 tracked pages on every write ran
// dozens of heavy aggregations against Mongo and timed out on slower DBs.
// Deeper pages are still cached on read (and via prefetch) — they just refill
// lazily on the next request instead of being proactively re-warmed.
const MAX_WARMED_PAGE = 3;

// Descriptors are tracked per-page; queries carry `page` as a string
// (posts view) or number (uploads views), so coerce defensively.
const descriptorPage = (descriptor: CacheDescriptor): number => {
  const q = descriptor.query as { page?: unknown } | null | undefined;
  const page = Number(q?.page);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

// Descriptor stored per cache entry so the warmer can replay the original
// fetch. `key` is the unprefixed cache key (matches what cacheService.set
// receives — the "crewcam:" prefix is added internally).
export interface CacheDescriptor {
  key: string;
  view: string;
  query: unknown;
  user: unknown;
}

type RefreshFn = (query: unknown, user: unknown) => Promise<unknown>;

const refreshFns = new Map<string, RefreshFn>();

export const registerCacheRefresh = (view: string, fn: RefreshFn): void => {
  refreshFns.set(view, fn);
};

const trackerKey = (companyId: string) => `${TRACKER_PREFIX}:${companyId}`;

// Called from route handlers right before/after a cache lookup so the
// warmer knows which (view, query, user) tuple produced each key.
// Field = cache key, value = JSON-encoded descriptor.
export const trackCacheKey = async (
  companyId: string | undefined,
  descriptor: CacheDescriptor,
): Promise<void> => {
  if (!companyId) return;
  // Keep the tracker small: only pages the warmer will actually re-run are
  // worth storing. Deeper pages are cached on read but never warmed.
  if (descriptorPage(descriptor) > MAX_WARMED_PAGE) return;
  const key = trackerKey(companyId);
  try {
    await redisService.hSet(key, descriptor.key, JSON.stringify(descriptor));
    await redisService.expire(key, TRACKER_TTL);
  } catch (err) {
    console.error("Cache: Failed to track cache descriptor:", err);
  }
};

// Re-runs every known fetch for the company and overwrites the cached value.
// Refreshes run sequentially to avoid hammering the DB with concurrent
// aggregations; individual failures are logged but don't abort the batch
// (so one bad descriptor doesn't poison the warm).
export const warmCompanyCache = async (companyId?: string): Promise<void> => {
  if (!companyId) return;
  const key = trackerKey(companyId);

  const entries = await redisService.hGetAll(key);
  if (!entries) return;

  const descriptors: CacheDescriptor[] = Object.values(entries)
    .map((raw) => {
      try {
        return JSON.parse(raw) as CacheDescriptor;
      } catch {
        return null;
      }
    })
    .filter((d): d is CacheDescriptor => !!d)
    // Defensive: skip deep-page descriptors that may linger in the tracker
    // from before the page cap was introduced (7-day TTL).
    .filter((d) => descriptorPage(d) <= MAX_WARMED_PAGE);

  for (const desc of descriptors) {
    const fn = refreshFns.get(desc.view);
    if (!fn) {
      // No refresh fn registered for this view (e.g., cron process didn't
      // import cacheWarmerSetup). Skip silently.
      continue;
    }
    try {
      const data = await fn(desc.query, desc.user);
      await cacheService.set(desc.key, data, { ttl: CacheTTL.SESSION });
    } catch (err) {
      console.error(`Cache: warm failed for ${desc.key} (${desc.view}):`, err);
    }
  }
};

export const prefetchPage = async (
  companyId: string,
  descriptor: CacheDescriptor,
): Promise<void> => {
  if (!companyId) return;
  const fn = refreshFns.get(descriptor.view);
  if (!fn) return;
  try {
    const existing = await cacheService.get(descriptor.key);
    if (existing !== null) return;
    await trackCacheKey(companyId, descriptor);
    const data = await fn(descriptor.query, descriptor.user);
    // NX: don't clobber a value the warmer wrote while this prefetch ran.
    await cacheService.setIfAbsent(descriptor.key, data, {
      ttl: CacheTTL.SESSION,
    });
  } catch (err) {
    console.error(
      `Cache: prefetch failed for ${descriptor.key} (${descriptor.view}):`,
      err,
    );
  }
};

// Coalesced background warms: mutations request a warm instead of awaiting
// one. If a warm for the company is already running, we just mark it dirty
// and re-run once after it finishes — N rapid mutations cost at most two
// warm passes instead of N overlapping aggregation storms against Mongo.
const warmInFlight = new Set<string>();
const warmDirty = new Set<string>();

export const scheduleCompanyCacheWarm = (companyId?: string): void => {
  if (!companyId) return;
  if (warmInFlight.has(companyId)) {
    warmDirty.add(companyId);
    return;
  }
  warmInFlight.add(companyId);
  warmCompanyCache(companyId)
    .catch((err) =>
      console.error(`Cache: background warm failed for ${companyId}:`, err),
    )
    .finally(() => {
      warmInFlight.delete(companyId);
      if (warmDirty.delete(companyId)) {
        scheduleCompanyCacheWarm(companyId);
      }
    });
};

// Called from cron once daily at 08:00 UTC (overnight in the US).
export const warmAllAllowlistedCompanies = async (): Promise<void> => {
  for (const id of REDIS_GRID_POSTS_CACHE_COMPANY_IDS) {
    await warmCompanyCache(id).catch((err) =>
      console.error(`Cache: warm failed for company ${id}:`, err),
    );
  }
};
