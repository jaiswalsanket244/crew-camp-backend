import { PostsHelper } from "../../routes/posts/helper";
import { ObjectId } from "../../utils/helpers/commonHelper";
import { registerCacheRefresh } from "./postCacheWarmer";

// Side-effect module: registering refresh fns at boot lets the warmer call
// helper queries without importing them directly (avoids a circular ref with
// posts/helper.ts, which imports the invalidation helpers from postCache.ts).
//
// Both lib/index.ts (main server) and lib/cron/cron.ts (cron process) import
// this file once so refreshFns is populated in each runtime.
//
// Important: descriptors come back from Redis as plain JSON, so any ObjectId
// fields are now strings. The helpers use these IDs inside `aggregate()`
// pipelines where Mongoose does NOT auto-cast strings to ObjectIds — passing
// a string straight into a $match matches zero documents and silently caches
// an empty response. The coerceXxx helpers below restore the ObjectId types
// before invoking the helpers.

interface PostsUserPayload {
  userId: unknown;
  role: string;
  companies: unknown[];
}

interface UploadsUserPayload {
  userId: unknown;
  role: string;
  companyIds: unknown[];
}

const asObjectIdIfString = (value: unknown): any =>
  typeof value === "string" ? ObjectId(value) : value;

const coerceIdArray = (arr: unknown): any[] =>
  Array.isArray(arr) ? arr.map(asObjectIdIfString) : [];

const coerceCompanies = (companies: unknown): any[] =>
  Array.isArray(companies)
    ? companies.map((c) => {
        const obj = (c ?? {}) as Record<string, any>;
        return {
          ...obj,
          companyId: asObjectIdIfString(obj.companyId),
        };
      })
    : [];

const coerceQueryIds = (query: any) => {
  if (!query || typeof query !== "object") return query;
  const next = { ...query };
  if (typeof next.projectId === "string") {
    next.projectId = ObjectId(next.projectId);
  }
  if (typeof next.userId === "string") {
    next.userId = ObjectId(next.userId);
  }
  if (Array.isArray(next.projectIds)) {
    next.projectIds = next.projectIds.map(asObjectIdIfString);
  }
  return next;
};

registerCacheRefresh("posts", async (query, user) => {
  const u = user as PostsUserPayload;
  return PostsHelper.findAll(
    asObjectIdIfString(u.userId),
    coerceCompanies(u.companies),
    coerceQueryIds(query),
    u.role,
  );
});

registerCacheRefresh("uploads-grid", async (query, user) => {
  const u = user as UploadsUserPayload;
  return PostsHelper.getGridPosts(coerceQueryIds(query), {
    userId: asObjectIdIfString(u.userId),
    role: u.role,
    companyIds: coerceIdArray(u.companyIds),
  });
});

registerCacheRefresh("uploads-list", async (query, user) => {
  const u = user as UploadsUserPayload;
  return PostsHelper.findAllUploads(coerceQueryIds(query), {
    userId: asObjectIdIfString(u.userId),
    role: u.role,
    companyIds: coerceIdArray(u.companyIds),
  });
});
