import * as crypto from "crypto";
import { Posts } from "../../db";
import { REDIS_GRID_POSTS_CACHE_COMPANY_IDS } from "../../utils/constants/constants";
import {
  MyUploadsQuery,
  PaginatedSearchQuery,
} from "../../utils/interfaces/query";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { scheduleCompanyCacheWarm } from "./postCacheWarmer";
import { cacheService } from "./cacheService";

// Shared cache layer for the GET /api/posts/uploads endpoint. Covers both
// `isGridView=true` (PostsHelper.getGridPosts) and the default list view
// (PostsHelper.findAllUploads). A single prefix scoped by companyId means
// any mutation can invalidate both modes with one deletePattern call.

export const POSTS_UPLOADS_CACHE_PREFIX = "posts-uploads";

// Pages 1..N are cached; deep pages skip cache to keep the keyspace bounded.
// Hit ratio falls off a cliff after page 2-3 and deep pages are rarely
// revisited within the 5-min TTL.
export const POSTS_UPLOADS_MAX_CACHED_PAGE = 20;

export const isPostsUploadsCacheEnabled = (companyId?: string): boolean => {
  return !!companyId && REDIS_GRID_POSTS_CACHE_COMPANY_IDS.includes(companyId);
};

const hasNonEmptyJsonArray = (raw?: string): boolean => {
  if (!raw) return false;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
};

// Narrow filters produce user-specific results that are almost never repeated
// within TTL — caching them bloats Redis with cold entries.
export const isCacheablePostsQuery = (
  query: PaginatedSearchQuery & MyUploadsQuery,
): boolean => {
  if ((query.page ?? 1) > POSTS_UPLOADS_MAX_CACHED_PAGE) return false;
  if (query.postId) return false;
  if (query.dateRange) return false;
  if (hasNonEmptyJsonArray(query.filterUsers)) return false;
  if (hasNonEmptyJsonArray(query.filterProjects)) return false;
  if (hasNonEmptyJsonArray(query.filterPostTags)) return false;
  if (hasNonEmptyJsonArray(query.filterProjectTags)) return false;
  return true;
};

// Cache key encodes everything that changes the response shape: companyId
// (prefix for scoped invalidation), plus userId+role (non-admins are scoped
// to their projectIds inside the helpers), plus all query filters/pagination,
// plus a `view` discriminator so different endpoints don't share entries.
export const buildPostsCacheKey = (
  query: PaginatedSearchQuery & MyUploadsQuery,
  user: { userId: ObjectIdType; role: string; companyIds: ObjectIdType[] },
  companyId: string,
  view: string,
): string => {
  const keyPayload = {
    view,
    userId: user?.userId?.toString(),
    role: user?.role,
    page: query.page,
    limit: query.limit,
    pageSize: query.pageSize,
    skips: query.skips,
    projectId: query.projectId?.toString(),
    userIdFilter: query.userId?.toString(),
    projectIds: query.projectIds?.map((id) => id?.toString()),
    filterUsers: query.filterUsers,
    filterProjects: query.filterProjects,
    filterPostTags: query.filterPostTags,
    filterProjectTags: query.filterProjectTags,
    postId: query.postId,
    sortBy: query.sortBy,
    dateRange: query.dateRange,
  };
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify(keyPayload))
    .digest("hex");
  return `${POSTS_UPLOADS_CACHE_PREFIX}:${companyId}:${hash}`;
};

export const invalidatePostsUploadsCache = async (
  companyId?: ObjectIdType | string,
): Promise<void> => {
  const id = companyId?.toString();
  // Non-allowlisted companies short-circuit here — zero added latency for
  // their writes. Allowlisted companies pay only a Redis pattern-delete:
  // the frontend's post-write refresh misses the cache and recomputes fresh
  // from Mongo, while a coalesced background warm repopulates the remaining
  // pages. Awaiting the full warm here (dozens of aggregations) held write
  // requests open long enough to exhaust the Mongo pool and time out.
  if (!isPostsUploadsCacheEnabled(id)) return;
  try {
    await cacheService.deletePattern(`${POSTS_UPLOADS_CACHE_PREFIX}:${id}:*`);
  } catch (err) {
    console.error("Cache: Failed to delete posts uploads cache:", err);
  }
  scheduleCompanyCacheWarm(id);
};

// --- uploads v2 count cache ---------------------------------------------
// The v2 grid feed pages via an index walk (cheap at any collection size),
// which leaves countDocuments over the matched set as the dominant cost.
// Totals only change on file create/delete, so a short-TTL Redis entry
// absorbs it. Keys live under the same `posts-uploads:{companyId}:` prefix,
// so the existing deletePattern invalidation on writes clears them too for
// allowlisted companies; for everyone else the TTL bounds staleness.

const POSTS_UPLOADS_COUNT_TTL_SECONDS = 60;

export const hashPostsCountQuery = (
  matchQuery: Record<string, unknown>,
): string =>
  crypto.createHash("sha1").update(JSON.stringify(matchQuery)).digest("hex");

// In-process fallback layer so counts stay cached per instance even when
// Redis is unreachable (e.g. local dev without REDIS_URL). Same TTL as the
// Redis entry; bounded so it can't grow unchecked. Unlike Redis it can't be
// invalidated by deletePattern, but a 60s-stale total is invisible in a
// paginated grid.
const localCountCache = new Map<string, { value: number; expiresAt: number }>();
const LOCAL_COUNT_CACHE_MAX = 1000;

const readLocalCount = (key: string): number | null => {
  const hit = localCountCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    localCountCache.delete(key);
    return null;
  }
  return hit.value;
};

const writeLocalCount = (key: string, value: number): void => {
  if (localCountCache.size >= LOCAL_COUNT_CACHE_MAX) {
    const now = Date.now();
    localCountCache.forEach(({ expiresAt }, k) => {
      if (expiresAt < now) localCountCache.delete(k);
    });
    if (localCountCache.size >= LOCAL_COUNT_CACHE_MAX) localCountCache.clear();
  }
  localCountCache.set(key, {
    value,
    expiresAt: Date.now() + POSTS_UPLOADS_COUNT_TTL_SECONDS * 1000,
  });
};

export const getCachedUploadsTotal = async (
  companyId: string | undefined,
  matchQuery: Record<string, unknown>,
  compute: () => Promise<number>,
): Promise<number> => {
  if (!companyId) return compute();
  const key = `${POSTS_UPLOADS_CACHE_PREFIX}:${companyId}:count:${hashPostsCountQuery(matchQuery)}`;

  const local = readLocalCount(key);
  if (local !== null) return local;

  try {
    const cached = await cacheService.get<number>(key);
    if (typeof cached === "number") {
      writeLocalCount(key, cached);
      return cached;
    }
  } catch (err) {
    console.error("Cache: uploads count read failed:", err);
  }
  const total = await compute();
  writeLocalCount(key, total);
  cacheService
    .set(key, total, { ttl: POSTS_UPLOADS_COUNT_TTL_SECONDS })
    .catch((err) => console.error("Cache: uploads count write failed:", err));
  return total;
};

// Looks up companyId from the post when the caller doesn't have it.
// Short-circuits when no companies are allowlisted to skip the extra read.
export const invalidatePostsUploadsCacheByPostId = async (
  postId: ObjectIdType | string,
): Promise<void> => {
  if (REDIS_GRID_POSTS_CACHE_COMPANY_IDS.length === 0) return;
  try {
    const post = await Posts.findById(postId, { companyId: 1 }).lean();
    if (post?.companyId) {
      await invalidatePostsUploadsCache(post.companyId as ObjectIdType);
    }
  } catch (err) {
    console.error(
      "Cache: Failed to invalidate posts uploads cache by postId:",
      err,
    );
  }
};
