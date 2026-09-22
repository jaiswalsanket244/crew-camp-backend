import * as express from "express";
import * as status from "http-status";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { instrumentBaselineLatency } from "../../search/baselineLatency";
import { searchWithFallback } from "../../search";
import { PostsUploadsQueryInput } from "../../search/types/queries";
import { UploadsPathResult } from "../../utils/interfaces/post";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import {
  convertTime,
  getDateWithTimeZone,
  getDayEnd,
  getDayStart,
  getLastMonthStartAndEnd,
  ObjectId,
  verifyToken,
} from "../../utils/helpers/commonHelper";
import { PostsHelper } from "./helper";
import {
  buildPostsCacheKey,
  isCacheablePostsQuery,
  isPostsUploadsCacheEnabled,
  POSTS_UPLOADS_MAX_CACHED_PAGE,
} from "../../services/redis/postCache";
import {
  prefetchPage,
  trackCacheKey,
} from "../../services/redis/postCacheWarmer";
import { cacheService } from "../../services/redis";
import { CacheTTL } from "../../utils/interfaces/cache";
import { ReportType, UserType } from "../../utils/interfaces/schemaInterface";
import { ProjectHelper } from "../projects/helper";
import { NotificationsHelpers } from "../notifications/helpers";
import {
  MyUploadsQuery,
  PaginatedSearchQuery,
} from "../../utils/interfaces/query";
import { CompanyHelpers } from "../company/helpers";
import { config } from "../../utils/configuration/config";
import {
  CURRENT_STATUS,
  NotificationCategory,
  NotificationMessageKey,
  PHOTO_MARKUP_ACCESS,
  USER_ROLE,
} from "../../utils/enums/enums";
import { translate } from "../../utils/i18n";
import * as dayjs from "dayjs";
import { UserHelper } from "../user/helper";
import { Validator } from "node-input-validator";
import { SORT_TYPE } from "../../utils/enums/post";
import { isValidObjectId } from "mongoose";
import { isAdminUser } from "../../utils/helpers/users";
import { fileService } from "../../services/awsBucket";
import { mediaVariantsService } from "../../services/mediaVariants";
import { IMediaVariantCandidate } from "../../utils/interfaces/files";
import { onPostCreated } from "../../integrations/hooks";

// Permissive view of the uploads helper result for the legacy date-bucketing block, which mutates `items` from rows into date buckets. Types are intentionally loose so the existing reshape (createdAt/files accessed across list + grid shapes) compiles unchanged.
interface UploadsBucketItem {
  createdAt?: string;
  files?: { timestamp?: string } & Array<{ timestamp?: string }>;
  [key: string]: unknown;
}
interface UploadsBucketPage {
  items?: UploadsBucketItem[];
  [key: string]: unknown;
}

export class PostsRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { _id, fullName } = req.user;

      const project = await ProjectHelper.getCompanyId(req.body.projectId);
      if (!project?.companyId) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project not found or has no associated company",
        });
      }

      const post = await PostsHelper.create(_id, req.body, project.companyId);
      ProjectHelper.updateProjectInfo(post.projectId);
      this.invokeNotication(post, { _id, fullName });

      // Trigger CRM integration sync (async, non-blocking)
      onPostCreated(post as any, req.user as any).catch((err) => {
        console.error("Integration hook error:", err);
      });
      ProjectHelper.updateProjectInfo(req.body.projectId);

      return SuccessResponse(res, status.OK, {
        message: "post created successfully",
        data: { postId: post._id },
      });
    } catch (error) {
      next(error);
    }
  };

  public static getPosts = async (
    req: AuthenticatedRequest & { query: { dateRange: any } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const user: UserType = req.user;
      const query = req.query;
      if (query?.dateRange) {
        query.dateRange = JSON.parse(query.dateRange);
        query.dateRange.startDate = getDayStart(query.dateRange.startDate);
        query.dateRange.endDate = getDayEnd(query.dateRange.endDate);
      }

      if (query?.lastMonth) {
        query.dateRange = getLastMonthStartAndEnd(new Date());
      }

      const companies = user.companies ?? [];
      const role = companies[0]?.role ?? "";
      const fetchAllPosts = () =>
        PostsHelper.findAll(user._id, companies, req.query, role);

      const companyIdForCache = companies[0]?.companyId?.toString();
      const cachePayload = {
        userId: user._id,
        role,
        companyIds: companies[0]?.companyId ? [companies[0].companyId] : [],
      };
      const useCache =
        isPostsUploadsCacheEnabled(companyIdForCache) &&
        isCacheablePostsQuery(req.query);

      let posts;
      let myProjectIds;
      if (useCache) {
        const cacheKey = buildPostsCacheKey(
          req.query,
          cachePayload,
          companyIdForCache,
          "posts",
        );
        // Record the descriptor so the warmer can replay this fetch on
        // invalidation or via the 22h cron.
        await trackCacheKey(companyIdForCache, {
          key: cacheKey,
          view: "posts",
          query: req.query,
          user: { ...cachePayload, companies },
        });
        const cachedTuple =
          await cacheService.get<[unknown, unknown]>(cacheKey);
        let wasCacheMiss = false;
        if (cachedTuple !== null) {
          [posts, myProjectIds] = cachedTuple as [unknown, unknown];
        } else {
          wasCacheMiss = true;
          [posts, myProjectIds] = await fetchAllPosts();
          cacheService
            .setIfAbsent(cacheKey, [posts, myProjectIds], {
              ttl: CacheTTL.SESSION,
            })
            .catch((err) =>
              console.error("Cache: Failed to cache posts:", err),
            );
        }
        // prefetch page logic
        if (wasCacheMiss) {
          const currentPage = Number((req.query as any).page) || 1;
          const totalPages = posts?.[0]?.totalPages;
          if (typeof totalPages === "number") {
            const upperBound = Math.min(
              totalPages,
              POSTS_UPLOADS_MAX_CACHED_PAGE,
            );
            const prefetchDescriptors = [];
            for (let p = currentPage + 1; p <= upperBound; p++) {
              const nextQuery = { ...(req.query as any), page: p };
              if (!isCacheablePostsQuery(nextQuery)) break;
              const nextKey = buildPostsCacheKey(
                nextQuery,
                cachePayload,
                companyIdForCache,
                "posts",
              );
              prefetchDescriptors.push({
                key: nextKey,
                view: "posts",
                query: nextQuery,
                user: { ...cachePayload, companies },
              });
            }
            (async () => {
              for (const descriptor of prefetchDescriptors) {
                await prefetchPage(companyIdForCache, descriptor);
              }
            })().catch((err) => {
              console.error("Cache: posts prefetch failed:", err);
            });
          }
        }
      } else {
        [posts, myProjectIds] = await fetchAllPosts();
      }

      if (
        posts?.[0] &&
        typeof posts[0] === "object" &&
        "items" in posts[0] &&
        posts[0].items?.length
      ) {
        posts[0].items = posts[0].items.map((p) => {
          const obj = {
            ...p,
            allowComment: myProjectIds.includes(p.projectId.toString()),
          };
          return req.isExternalRequest ? { ...p } : obj;
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "post fetched successfully",
        data: posts,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getUploads = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      let user;
      let companys;
      instrumentBaselineLatency(res, "posts.uploads", () =>
        user?.companyId?.toString(),
      );
      if (
        (req as { parityForcePath?: "es" | "mongo" }).parityForcePath &&
        req.user
      ) {
        // Parity harness injects a pre-decoded actor — ONLY when parityForcePath is set. NOT in production: jwtDecoder sets req.user globally on /api, so gating on req.user alone would wrongly skip this optional-auth handler's own token decode for real requests.
        user = req.user;
      } else if (req.headers?.authorization) {
        try {
          let authorizationHeader = req.headers.authorization;
          if (authorizationHeader.includes("Bearer")) {
            authorizationHeader = authorizationHeader.split(" ")[1];
          }
          const decoded = await verifyToken(authorizationHeader);

          [user, companys] = await Promise.all([
            UserHelper.findOne(ObjectId(decoded.data._id)),
            CompanyHelpers.getMyCompanies(ObjectId(decoded.data._id)),
          ]);
          user.companies = companys;
          user.companyId = companys[0].companyId;
        } catch (er) {
          /* empty */
        }
      }

      const query: PaginatedSearchQuery &
        MyUploadsQuery & { timeZone?: string } = req.query;
      query.page = Number(query.page) || 1;
      query.pageSize = Number(query.limit) || 50;
      query.skips = (query.page - 1) * query.pageSize;
      query.projectIds = [];

      const additionalParameters = {};
      if (query.filterProjectTags) {
        additionalParameters["tags"] = {
          $in: JSON.parse(query.filterProjectTags).map((tag) => ObjectId(tag)),
        };
      }
      // Skip expensive project lookup for grid view, and also for the
      // post-feed list when the caller is admin + no per-project-tag filter
      // (the helper falls back to a companyId-direct filter, which uses the
      // indexed companyId+status+createdAt path on Posts).
      const userRole = user?.companies?.[0]?.role;
      const adminFastPath =
        !!userRole && isAdminUser(userRole) && !query.filterProjectTags;
      if (user?.companyId && !query.isGridView && !adminFastPath) {
        query.projectIds = await ProjectHelper.getCompanyProjects(
          [user.companyId],
          false,
          additionalParameters,
        );
      }

      if (query?.dateRange) {
        query.dateRange = JSON.parse(query.dateRange);
        query.dateRange.startDate = getDayStart(query.dateRange.startDate);
        query.dateRange.endDate = getDayEnd(query.dateRange.endDate);
      }

      if (query?.lastMonth) {
        query.dateRange = getLastMonthStartAndEnd(new Date());
      }

      let payload;
      if (user?._id) {
        payload = {
          userId: user._id,
          role: user?.companies?.[0]?.role,
          companyIds: [user.companyId],
        };
      }

      const sortByTimestamp =
        query.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
        query.sortBy === SORT_TYPE.DATE_TAKEN_DESC;

      // Mongo path = the existing impl verbatim (list or grid). ES path (list mode only) builds the input lazily + hydrates via getUploadsFromES. GUEST/grid/external/timestamp-sort stay on Mongo; guests (no companyId) bypass searchWithFallback entirely.
      const mongoCall = async (): Promise<UploadsPathResult> =>
        (query.isGridView
          ? await PostsHelper.getGridPosts(query, payload)
          : await PostsHelper.findAllUploads(
              query,
              payload,
            )) as unknown as UploadsPathResult;

      const esFn = async (): Promise<UploadsPathResult> => {
        // Resolve project + company scope to mirror findAllUploads (helper.ts:420-462): explicit
        // filterProjects → projectId (company re-derived from the project, for shared links) →
        // non-admin getMineAndCompanyProjects; admin → company-wide.
        let filterProjects: ObjectIdType[] | undefined;
        let scopedProjectId: ObjectIdType | undefined;
        // Default to the caller's company. A projectId (shared-project link) re-scopes to the
        // project's company so cross-company shared links resolve like Mongo (helper.ts:425-429).
        let scopedCompanyId: ObjectIdType = user.companyId;
        if (query.filterProjects) {
          const arr = JSON.parse(query.filterProjects).map((p: string) =>
            ObjectId(p),
          );
          filterProjects = arr.length ? arr : undefined;
        } else if (query.projectId) {
          scopedProjectId = ObjectId(query.projectId);
          const project = await ProjectHelper.getCompanyId(query.projectId);
          if (project?.companyId) {
            scopedCompanyId = project.companyId as ObjectIdType;
          }
        } else if (userRole && !isAdminUser(userRole)) {
          // No tag arg: shipped findAllUploads scopes non-admins by membership only
          // (helper.ts:457-460). Passing filterProjectTags here would diverge from Mongo.
          const { projectIds } = await ProjectHelper.getMineAndCompanyProjects(
            [user.companyId],
            user._id,
          );
          filterProjects = projectIds?.length ? projectIds : undefined;
        }

        const filterUsersArr = query.filterUsers
          ? JSON.parse(query.filterUsers).map((u: string) => ObjectId(u))
          : undefined;
        const filterTagsArr = query.filterPostTags
          ? JSON.parse(query.filterPostTags).map((t: string) => ObjectId(t))
          : undefined;
        const searchTerm =
          query.postId && String(query.postId).trim()
            ? String(query.postId).trim()
            : undefined;

        const input: PostsUploadsQueryInput = {
          companyId: scopedCompanyId,
          projectId: scopedProjectId,
          filterProjects,
          userId: query.userId ? ObjectId(query.userId) : undefined,
          filterUsers: filterUsersArr?.length ? filterUsersArr : undefined,
          filterTags: filterTagsArr?.length ? filterTagsArr : undefined,
          search: searchTerm,
          dateRange: query.dateRange
            ? { gte: query.dateRange.startDate, lte: query.dateRange.endDate }
            : undefined,
          sortBy: query.sortBy as SORT_TYPE,
          page: query.page,
          pageSize: query.pageSize,
        };
        return PostsHelper.getUploadsFromES(input);
      };

      const computePosts = async (): Promise<UploadsBucketPage[]> => {
        if (!user?.companyId) {
          return (await mongoCall()) as unknown as UploadsBucketPage[];
        }
        const esCall: () => Promise<UploadsPathResult> =
          query.isGridView || req.isExternalRequest || sortByTimestamp
            ? mongoCall
            : esFn;
        return (await searchWithFallback(
          "posts.uploads",
          user.companyId,
          esCall,
          mongoCall,
          // Parity harness — undefined on every production request.
          {
            forcePath: (req as { parityForcePath?: "es" | "mongo" })
              .parityForcePath,
          },
        )) as unknown as UploadsBucketPage[];
      };
      const companyIdForCache = user?.companyId?.toString();
      const isParityRequest = !!(req as { parityForcePath?: "es" | "mongo" })
        .parityForcePath;
      const cacheView = query.isGridView ? "uploads-grid" : "uploads-list";
      const useCache =
        !isParityRequest &&
        !!payload &&
        isPostsUploadsCacheEnabled(companyIdForCache) &&
        isCacheablePostsQuery(query);

      let posts: UploadsBucketPage[];
      if (!useCache) {
        posts = await computePosts();
      } else {
        const cacheKey = buildPostsCacheKey(
          query,
          payload,
          companyIdForCache,
          cacheView,
        );
        await trackCacheKey(companyIdForCache, {
          key: cacheKey,
          view: cacheView,
          query,
          user: payload,
        });
        const cached = await cacheService.get<UploadsBucketPage[]>(cacheKey);
        if (cached !== null) {
          posts = cached;
        } else {
          posts = await computePosts();
          cacheService
            .setIfAbsent(cacheKey, posts, { ttl: CacheTTL.SESSION })
            .catch((err) =>
              console.error("Cache: Failed to cache uploads:", err),
            );
          const totalPages = (posts?.[0] as { totalPages?: number })
            ?.totalPages;
          if (typeof totalPages === "number") {
            const upperBound = Math.min(
              totalPages,
              POSTS_UPLOADS_MAX_CACHED_PAGE,
            );
            const prefetchDescriptors = [];
            for (let p = query.page + 1; p <= upperBound; p++) {
              const nextQuery = {
                ...query,
                page: p,
                skips: (p - 1) * query.pageSize,
              };
              if (!isCacheablePostsQuery(nextQuery)) break;
              const nextKey = buildPostsCacheKey(
                nextQuery,
                payload,
                companyIdForCache,
                cacheView,
              );
              prefetchDescriptors.push({
                key: nextKey,
                view: cacheView,
                query: nextQuery,
                user: payload,
              });
            }
            (async () => {
              for (const descriptor of prefetchDescriptors) {
                await prefetchPage(companyIdForCache, descriptor);
              }
            })().catch((err) => {
              console.error("Cache: uploads prefetch failed:", err);
            });
          }
        }
      }

      if (
        posts?.[0] &&
        typeof posts[0] === "object" &&
        "items" in posts[0] &&
        posts[0].items?.length
      ) {
        const allPosts = posts[0].items.map((p) => {
          return {
            ...p,
            uploadedAt: p.createdAt,
            createdAt: getDateWithTimeZone(p.createdAt, query.timeZone),
          };
        });
        const groupedData = allPosts.reduce((acc, item) => {
          const sortTime =
            req?.query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
            req?.query?.sortBy === SORT_TYPE.DATE_TAKEN_DESC
              ? item?.files?.timestamp
                ? getDateWithTimeZone(item.files.timestamp, query.timeZone)
                : item?.files[0]?.timestamp
                  ? getDateWithTimeZone(item.files[0].timestamp, query.timeZone)
                  : item.createdAt
              : item.createdAt;
          (acc[sortTime] = acc[sortTime] || []).push(item);
          return acc;
        }, {});

        posts[0].items = Object.keys(groupedData)
          .sort((a, b) => {
            const dateOfA = dayjs(a, "MM/DD/YYYY").unix();
            const dateOfB = dayjs(b, "MM/DD/YYYY").unix();
            if (
              req?.query?.sortBy === SORT_TYPE.OLDEST ||
              req?.query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC
            ) {
              return dateOfA - dateOfB;
            } else {
              return dateOfB - dateOfA;
            }
          })
          .map((date) => ({
            _id: convertTime(date, true),
            posts: groupedData[date],
          }));
      }
      return SuccessResponse(res, status.OK, {
        message: "post created succesfully",
        data: posts,
      });
    } catch (error) {
      next(error);
    }
  };

  // Same date-bucketing reshape getUploads performs inline — duplicated for
  // the v2 handler so the v1 code path stays untouched. Mutates posts[0].items
  // from flat rows into [{ _id: date, posts: [...] }] buckets.
  // public so the offline bundle can produce identically-shaped uploads pages
  public static bucketUploadsByDate = (
    posts: UploadsBucketPage[],
    query: { sortBy?: string; timeZone?: string },
  ): void => {
    if (
      !posts?.[0] ||
      typeof posts[0] !== "object" ||
      !("items" in posts[0]) ||
      !posts[0].items?.length
    ) {
      return;
    }
    const allPosts = posts[0].items.map((p) => ({
      ...p,
      uploadedAt: p.createdAt,
      createdAt: getDateWithTimeZone(p.createdAt, query.timeZone),
    }));

    const sortByTimestamp =
      query.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
      query.sortBy === SORT_TYPE.DATE_TAKEN_DESC;
    const groupedData = allPosts.reduce(
      (acc, item) => {
        const sortTime = sortByTimestamp
          ? item?.files?.timestamp
            ? getDateWithTimeZone(item.files.timestamp, query.timeZone)
            : item?.files?.[0]?.timestamp
              ? getDateWithTimeZone(item.files[0].timestamp, query.timeZone)
              : item.createdAt
          : item.createdAt;
        (acc[sortTime] = acc[sortTime] || []).push(item);
        return acc;
      },
      {} as Record<string, UploadsBucketItem[]>,
    );

    posts[0].items = Object.keys(groupedData)
      .sort((a, b) => {
        const dateOfA = dayjs(a, "MM/DD/YYYY").unix();
        const dateOfB = dayjs(b, "MM/DD/YYYY").unix();
        if (
          query.sortBy === SORT_TYPE.OLDEST ||
          query.sortBy === SORT_TYPE.DATE_TAKEN_ASC
        ) {
          return dateOfA - dateOfB;
        }
        return dateOfB - dateOfA;
      })
      .map((date) => ({
        _id: convertTime(date, true),
        posts: groupedData[date],
      }));
  };

  // V2 of GET /uploads: identical request/response contract, but grid mode is
  // served by getGridPostsV2's indexed pagination (persisted postSortDate)
  // instead of a full-collection window sort. No ES fallback, parity harness,
  // or Redis payload cache — the query is meant to be fast enough to serve
  // directly. List mode delegates to the existing findAllUploads.
  public static getUploadsV2 = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        page: "integer",
        limit: "integer",
        projectId: "string",
        userId: "string",
        sortBy: "string",
        timeZone: "string",
      });
      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      if (req.query.projectId && !isValidObjectId(req.query.projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid projectId",
        });
      }

      let user;
      instrumentBaselineLatency(res, "posts.uploads.v2", () =>
        user?.companyId?.toString(),
      );

      // Optional auth, mirroring getUploads: shared-link/guest requests may
      // arrive without a (valid) token and are scoped by projectId instead.
      if (req.headers?.authorization) {
        try {
          let authorizationHeader = req.headers.authorization;
          if (authorizationHeader.includes("Bearer")) {
            authorizationHeader = authorizationHeader.split(" ")[1];
          }
          const decoded = await verifyToken(authorizationHeader);
          const [userDoc, companys] = await Promise.all([
            UserHelper.findOne(ObjectId(decoded.data._id)),
            CompanyHelpers.getMyCompanies(ObjectId(decoded.data._id)),
          ]);
          user = userDoc;
          user.companies = companys;
          user.companyId = companys[0].companyId;
        } catch (er) {
          /* proceed as guest */
        }
      }

      const query: PaginatedSearchQuery &
        MyUploadsQuery & { timeZone?: string } = req.query;
      query.page = Number(query.page) || 1;
      query.pageSize = Number(query.limit) || 50;
      query.skips = (query.page - 1) * query.pageSize;
      query.projectIds = [];

      if (query?.dateRange) {
        query.dateRange = JSON.parse(query.dateRange);
        query.dateRange.startDate = getDayStart(query.dateRange.startDate);
        query.dateRange.endDate = getDayEnd(query.dateRange.endDate);
      }
      if (query?.lastMonth) {
        query.dateRange = getLastMonthStartAndEnd(new Date());
      }

      let payload;
      if (user?._id) {
        payload = {
          userId: user._id,
          role: user?.companies?.[0]?.role,
          companyIds: [user.companyId],
        };
      }

      let posts: UploadsBucketPage[];
      if (query.isGridView) {
        posts = (await PostsHelper.getGridPostsV2(
          query,
          payload,
        )) as unknown as UploadsBucketPage[];
      } else {
        // List mode: same projectIds scoping the v1 handler applies before
        // findAllUploads (admins without a project-tag filter skip it).
        const userRole = user?.companies?.[0]?.role;
        const adminFastPath =
          !!userRole && isAdminUser(userRole) && !query.filterProjectTags;
        if (user?.companyId && !adminFastPath) {
          const additionalParameters = query.filterProjectTags
            ? {
                tags: {
                  $in: JSON.parse(query.filterProjectTags).map((tag) =>
                    ObjectId(tag),
                  ),
                },
              }
            : {};
          query.projectIds = await ProjectHelper.getCompanyProjects(
            [user.companyId],
            false,
            additionalParameters,
          );
        }
        posts = (await PostsHelper.findAllUploads(
          query,
          payload,
        )) as unknown as UploadsBucketPage[];
      }

      this.bucketUploadsByDate(posts, query);

      return SuccessResponse(res, status.OK, {
        message: "post fetched successfully",
        data: posts,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getRecentUploads = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery &
        MyUploadsQuery & { timeZone?: string } = req.query;

      const { projectId } = req.query;

      if (!projectId || !isValidObjectId(projectId)) {
        return SuccessResponse(res, status.OK, {
          message: "Success.",
          data: [],
        });
      }

      const posts = await PostsHelper.findRecentUploads(query);

      if (
        posts?.[0] &&
        typeof posts[0] === "object" &&
        "items" in posts[0] &&
        posts[0].items?.length
      ) {
        const sortByTimestamp =
          !query?.sortBy ||
          query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
          query?.sortBy === SORT_TYPE.DATE_TAKEN_DESC;

        const allPosts = posts[0].items.map((p) => {
          return {
            ...p,
            files: [p.files],
            uploadedAt: p.createdAt,
            createdAt: getDateWithTimeZone(p.createdAt, query.timeZone),
          };
        });

        const groupedData = allPosts.reduce((acc, item) => {
          const sortTime = sortByTimestamp
            ? item?.files?.[0]?.timestamp
              ? getDateWithTimeZone(item.files[0].timestamp, query.timeZone)
              : item.createdAt
            : item.createdAt;
          (acc[sortTime] = acc[sortTime] || []).push(item);
          return acc;
        }, {});

        posts[0].items = Object.keys(groupedData)
          .sort((a, b) => {
            const dateOfA = dayjs(a, "MM/DD/YYYY").unix();
            const dateOfB = dayjs(b, "MM/DD/YYYY").unix();
            return query?.sortBy === SORT_TYPE.OLDEST ||
              query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC
              ? dateOfA - dateOfB
              : dateOfB - dateOfA;
          })
          .map((date) => ({
            _id: convertTime(date, true),
            posts: groupedData[date],
          }));
      }
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: posts,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getPostData = async (
    req: AuthenticatedRequest & { query: { postId?: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      let userId;
      if (req.headers?.authorization) {
        try {
          let authorizationHeader = req.headers.authorization;
          if (authorizationHeader.includes("Bearer")) {
            authorizationHeader = authorizationHeader.split(" ")[1];
          }
          const decoded = await verifyToken(authorizationHeader);

          userId = ObjectId(decoded.data._id);
        } catch (er) {
          /* empty */
        }
      }

      const [postsData, myProjectIds] = await Promise.all([
        PostsHelper.getPostData(req?.query?.postId),
        ProjectHelper.getMyProjectsArray(userId),
      ]);

      const posts = postsData.map((p) => {
        return {
          ...p,
          allowComment: myProjectIds.includes(p.projectId.toString()),
        };
      });

      return SuccessResponse(res, status.OK, {
        message: "succesfull",
        data: posts,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getPostFiles = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { id } = req.params;
      if (!id || !isValidObjectId(id)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid post id",
        });
      }

      const post = await PostsHelper.getPostsById(ObjectId(id));

      if (!post || post.length === 0) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      const postDoc = post[0];
      const postOwnerId = postDoc.userId;

      // Auth: post owner OR company admin OR manager role (mirrors `update`).
      if (postOwnerId.toString() !== req.user._id.toString()) {
        const companyData = await ProjectHelper.getCompanyId(postDoc.projectId);
        const [companyAdmin, userRole] = await Promise.all([
          CompanyHelpers.getCompanyAdminId(companyData.companyId),
          CompanyHelpers.getCompanyMemberRole(
            companyData.companyId,
            req.user._id,
          ),
        ]);
        const authorized =
          req.user._id.toString() === companyAdmin.userId.toString() ||
          userRole?.role === USER_ROLE.MANAGER;
        if (!authorized) {
          return ErrorResponse(res, status.FORBIDDEN, {
            message: "Unauthorized to read this post",
          });
        }
      }

      const files = (postDoc.files ?? []).map((f: any) => {
        const entry: Record<string, unknown> = {
          _id: f._id,
          url: f.url,
          fileType: f.fileType,
        };
        if (f.hash) entry.hash = f.hash;
        return entry;
      });

      // Private cache: caller-side memoization is OK; CDNs must not serve
      // stale data because verifier decisions depend on the response.
      res.setHeader("Cache-Control", "private, max-age=60");

      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: files,
      });
    } catch (error) {
      next(error);
    }
  };

  public static invokeNotication = async (post, user) => {
    const notications = [];

    const [users, projectData] = await Promise.all([
      ProjectHelper.getProjectMembers(post.projectId),
      ProjectHelper.getProjectData(post.projectId),
    ]);

    const url = config.APP_URL + `/Postscreen?postId=${post._id}`;

    users.forEach((u) => {
      if (u._id.toString() == user._id.toString()) return;
      const messageParams = {
        actor: user.fullName,
        project: projectData.name,
      };
      notications.push({
        userId: u._id,
        message: translate(NotificationMessageKey.PROJECT_POST, messageParams),
        messageKey: NotificationMessageKey.PROJECT_POST,
        messageParams,
        postId: post._id,
        createdBy: user._id,
        category: NotificationCategory.PROJECT_POST,
        url,
      });
    });

    await NotificationsHelpers.createAndSendNotfications(
      notications,
      true,
      projectData.name,
    );
  };

  public static getSearchRecommendation = async (
    req: AuthenticatedRequest & { query: { search: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const companyMembers = await CompanyHelpers.getCompanyMembers(
        req?.user?.companies?.map((a) => a.companyId),
      );

      const response = {
        message: "succesfull",
        data: [],
      };

      const { projectIds, companyProjectIds } =
        await ProjectHelper.getMineAndCompanyProjects(
          [req.user.companyId],
          req.user._id,
        );

      let myProjects = companyProjectIds;

      if (req.user?.companies?.[0]?.role == USER_ROLE.STANDARD) {
        myProjects = projectIds;
      }

      if (req.query.search) {
        const [posts, users, projects, location, descriptions] =
          await PostsHelper.getSearchRecommendation(
            req.query.search,
            companyMembers.map((u) => u.userId),
            myProjects,
            req.user.companyId,
          );

        const existingIds = {};
        response.data = [
          ...projects,
          ...users,
          ...posts,
          ...descriptions,
          ...location,
        ].filter((item) => {
          if (existingIds[item._id]) {
            return false;
          }
          existingIds[item._id] = true;
          return true;
        });
      }

      return SuccessResponse(res, status.OK, response);
    } catch (error) {
      next(error);
    }
  };

  public static reportPost = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const admin = await CompanyHelpers.getCompanyAdminId(req.user.companyId);

      if (admin?.userId) {
        const body: ReportType = req.body;
        body.userId = admin.userId;
        body.url = config.APP_URL + `/ReportedPost?postId=${body.postId}`;

        const post = await PostsHelper.getPostStatus(body.postId);

        if (post.status == CURRENT_STATUS.ACTIVE) {
          await PostsHelper.reportPost(req.user, body);
          await NotificationsHelpers.createAndSendNotfications(
            [
              {
                userId: admin.userId,
                message: body.description,
                createdBy: req.user._id,
                postId: ObjectId(body.postId),
                url: body.url,
                category: NotificationCategory.REPORT,
              },
            ],
            true,
            body.reason,
          );
        }
      }

      return SuccessResponse(res, status.OK, {
        message: "Reported successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static update = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        postId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const postData = await PostsHelper.getPostData(req.body.postId);
      const postOwnerId = postData[0].userId;

      if (!postData.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }
      if (postOwnerId.toString() !== req.user._id.toString()) {
        const companyData = await ProjectHelper.getCompanyId(
          postData[0].projectId,
        );
        const companyAdmin = await CompanyHelpers.getCompanyAdminId(
          companyData.companyId,
        );
        const userRole = await CompanyHelpers.getCompanyMemberRole(
          companyData.companyId,
          req.user._id,
        );
        if (!(
          req.user._id.toString() === companyAdmin.userId.toString() ||
          userRole?.role === USER_ROLE.MANAGER
        )) {
          return ErrorResponse(res, status.FORBIDDEN, {
            message: "Unauthorized to update this post",
          });
        }
      }

      await PostsHelper.put(req.body);
      ProjectHelper.updateProjectInfo(
        req.body.projectId || postData[0].projectId,
      );

      return SuccessResponse(res, status.OK, {
        message: "Post updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateTags = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        postId: "string|required",
        fileId: "string|required",
        tagIds: "array",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const postData = await PostsHelper.getPostData(req.body.postId);

      if (!postData.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      const projectData = await ProjectHelper.getUserProjectData({
        projectId: postData[0].projectId,
        userId: req.user._id,
      });

      if (!projectData) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Unauthorized to update this post",
        });
      }

      await PostsHelper.updateTags(req.body);

      ProjectHelper.updateProjectInfo(postData[0].projectId);

      return SuccessResponse(res, status.OK, {
        message: "Post updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateFileDescription = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        postId: "string|required",
        fileId: "string|required",
        description: "string|maxLength:200",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { postId, fileId, description } = req.body;

      const file = await PostsHelper.getPostFileById({ postId, fileId });

      if (!file) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "File not found",
        });
      }

      const projectData = await ProjectHelper.getUserProjectData({
        projectId: file.projectId,
        userId: req.user._id,
      });

      if (!projectData) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Unauthorized to update this photo",
        });
      }

      await PostsHelper.updateFileDescription({
        postId,
        fileId,
        description: description ?? "",
      });

      ProjectHelper.updateProjectInfo(file.projectId);

      return SuccessResponse(res, status.OK, {
        message: "Description updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static bulkUpdateTags = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        pairs: "array|required",
        tags: "array|required",
        isAddTag: "boolean|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { pairs, tags, isAddTag } = req.body;
      const isAdd = Boolean(isAddTag);

      if (!Array.isArray(pairs) || pairs.length === 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "pairs must be a non-empty array",
        });
      }

      if (!Array.isArray(tags) || tags.length === 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "tags must be a non-empty array",
        });
      }

      for (const tagId of tags) {
        if (!isValidObjectId(tagId)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `Invalid tagId: ${tagId}`,
          });
        }
      }

      const validPairs: Array<{ postId: string; fileId: string }> = [];
      for (const p of pairs) {
        if (!p || typeof p !== "object") continue;
        if (!isValidObjectId(p.postId) || !isValidObjectId(p.fileId)) continue;
        validPairs.push({ postId: p.postId, fileId: p.fileId });
      }

      if (validPairs.length === 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "pairs must contain valid postId and fileId entries",
        });
      }

      const result = await PostsHelper.bulkUpdateTags(validPairs, tags, isAdd);

      PostsHelper.touchPostProjects(validPairs.map((p) => p.postId));

      return SuccessResponse(res, status.OK, {
        message: isAdd
          ? "Tags added successfully"
          : "Tags removed successfully",
        data: { modifiedCount: result.modifiedCount },
      });
    } catch (error) {
      next(error);
    }
  };

  public static getPostDataForScroll = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        postId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      let userId;
      if (req.headers?.authorization) {
        try {
          let authorizationHeader = req.headers.authorization;
          if (authorizationHeader.includes("Bearer")) {
            authorizationHeader = authorizationHeader.split(" ")[1];
          }
          const decoded = await verifyToken(authorizationHeader);

          userId = ObjectId(decoded.data._id);
        } catch (er) {
          /* empty */
        }
      }

      let { projectId, page } = req.query;
      const { postId, limit = 10 } = req.query;

      if (!isValidObjectId(postId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "postId is required",
        });
      }

      // note search arrives as `search` — `postId` is the anchor post here
      const sortBy = Object.values(SORT_TYPE).includes(
        req.query.sortBy as SORT_TYPE,
      )
        ? (req.query.sortBy as SORT_TYPE)
        : SORT_TYPE.DATE_TAKEN_DESC;

      let dateRange;
      if (req.query.dateRange) {
        const parsedRange = JSON.parse(req.query.dateRange as string);
        dateRange = {
          startDate: getDayStart(parsedRange.startDate),
          endDate: getDayEnd(parsedRange.endDate),
        };
      }
      if (req.query.lastMonth) {
        dateRange = getLastMonthStartAndEnd(new Date());
      }

      const scrollFilters = {
        userId: req.query.userId as string,
        filterUsers: req.query.filterUsers as string,
        filterPostTags: req.query.filterPostTags as string,
        search: req.query.search as string,
        dateRange,
      };

      if (!page) {
        if (!projectId || !isValidObjectId(projectId)) {
          const postData = await PostsHelper.getPostProjectId(postId);
          projectId = postData.projectId;
        }
        if (!isValidObjectId(projectId)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "projectId is required",
          });
        }
        const postIndex = await PostsHelper.getPostIndexInProject(
          ObjectId(projectId),
          postId,
          scrollFilters,
          sortBy,
          req.query.fileId as string,
        );
        page = Math.ceil((postIndex + 1) / limit);
      }

      if (!isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "projectId is required",
        });
      }

      const [postsData, allowComment] = await Promise.all([
        PostsHelper.getprojectPosts(
          {
            ...scrollFilters,
            page,
            limit,
            projectId: ObjectId(projectId),
          },
          sortBy,
        ),
        ProjectHelper.checkIfImPartOfProject(userId, projectId),
      ]);

      const items = postsData.items.map((post) => ({
        ...post,
        fileIndex: post.fileIndex,
        allowComment,
      }));

      // Backfill missing image quickViews / video thumbnails in the
      // background; clients fall back to file.url until populated.
      mediaVariantsService.enqueueCandidates(items.map((item) => item.file));

      return SuccessResponse(res, status.OK, {
        message: "succesfull",
        data: {
          items: items,
          total: postsData.total,
          page: postsData.page,
          pageSize: postsData.pageSize,
          totalPages: postsData.totalPages,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  // V2 of GET /scroll: identical contract, but the anchor lookup is an
  // index-range count and the page fetch is an indexed walk (see
  // getPostIndexInProjectV2 / getprojectPostsV2) instead of window-sorting
  // every file in the project per request.
  public static getPostDataForScrollV2 = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        postId: "string|required",
        projectId: "string",
        page: "integer",
        limit: "integer",
        sortBy: "string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      let userId;
      if (req.headers?.authorization) {
        try {
          let authorizationHeader = req.headers.authorization;
          if (authorizationHeader.includes("Bearer")) {
            authorizationHeader = authorizationHeader.split(" ")[1];
          }
          const decoded = await verifyToken(authorizationHeader);

          userId = ObjectId(decoded.data._id);
        } catch (er) {
          /* empty */
        }
      }

      let { projectId, page } = req.query;
      const { postId, limit = 10 } = req.query;

      if (!isValidObjectId(postId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "postId is required",
        });
      }

      // note search arrives as `search` — `postId` is the anchor post here
      const sortBy = Object.values(SORT_TYPE).includes(
        req.query.sortBy as SORT_TYPE,
      )
        ? (req.query.sortBy as SORT_TYPE)
        : SORT_TYPE.DATE_TAKEN_DESC;

      let dateRange;
      if (req.query.dateRange) {
        const parsedRange = JSON.parse(req.query.dateRange as string);
        dateRange = {
          startDate: getDayStart(parsedRange.startDate),
          endDate: getDayEnd(parsedRange.endDate),
        };
      }
      if (req.query.lastMonth) {
        dateRange = getLastMonthStartAndEnd(new Date());
      }

      const scrollFilters = {
        userId: req.query.userId as string,
        filterUsers: req.query.filterUsers as string,
        filterPostTags: req.query.filterPostTags as string,
        search: req.query.search as string,
        dateRange,
      };

      if (!page) {
        if (!projectId || !isValidObjectId(projectId)) {
          const postData = await PostsHelper.getPostProjectId(postId);
          projectId = postData.projectId;
        }
        if (!isValidObjectId(projectId)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "projectId is required",
          });
        }
        const postIndex = await PostsHelper.getPostIndexInProjectV2(
          ObjectId(projectId),
          postId,
          scrollFilters,
          sortBy,
          req.query.fileId as string,
        );
        page = Math.ceil((postIndex + 1) / limit);
      }

      if (!isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "projectId is required",
        });
      }

      const [postsData, allowComment] = await Promise.all([
        PostsHelper.getprojectPostsV2(
          {
            ...scrollFilters,
            page,
            limit,
            projectId: ObjectId(projectId),
          },
          sortBy,
        ),
        ProjectHelper.checkIfImPartOfProject(userId, projectId),
      ]);

      const items = postsData.items.map((post) => ({
        ...post,
        allowComment,
      }));

      // Backfill missing image quickViews / video thumbnails in the
      // background; clients fall back to file.url until populated.
      mediaVariantsService.enqueueCandidates(
        items.map((item) => (item as { file?: IMediaVariantCandidate }).file),
      );

      return SuccessResponse(res, status.OK, {
        message: "succesfull",
        data: {
          items: items,
          total: postsData.total,
          page: postsData.page,
          pageSize: postsData.pageSize,
          totalPages: postsData.totalPages,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteFile = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        postId: "string|required",
        fileId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { postId, fileId } = req.body;

      if (!isValidObjectId(postId) || !isValidObjectId(fileId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "postId is required",
        });
      }

      const postData = await PostsHelper.getPostData(postId);
      const postOwnerId = postData[0].userId;

      if (!postData.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      if (
        postOwnerId.toString() !== req.user._id.toString() &&
        req.user?.companies?.[0]?.role !== USER_ROLE.MANAGER
      ) {
        const companyData = await ProjectHelper.getCompanyId(
          postData[0].projectId,
        );
        const companyAdmin = await CompanyHelpers.getCompanyAdminId(
          companyData.companyId,
        );
        const userRole = await CompanyHelpers.getCompanyMemberRole(
          companyData.companyId,
          req.user._id,
        );
        if (!(
          req.user._id.toString() === companyAdmin.userId.toString() ||
          userRole?.role === USER_ROLE.MANAGER
        )) {
          return ErrorResponse(res, status.FORBIDDEN, {
            message: "Unauthorized to update this post",
          });
        }
      }

      // Soft delete the file (marks as DELETED, doesn't remove from S3 yet)
      await PostsHelper.deleteFile(ObjectId(postId), ObjectId(fileId));

      SuccessResponse(res, status.OK, {
        message: "File moved to trash bin",
      });
    } catch (error) {
      next(error);
    }
  };

  public static replaceOriginalFile = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body.data, {
        postId: "string|required",
        fileId: "string|required",
        fileUrl: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { postId, fileId, fileUrl, size, fileType, editDocument } =
        req.body.data;

      if (!isValidObjectId(postId) || !isValidObjectId(fileId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid postId or fileId",
        });
      }

      const postData = await PostsHelper.getPostData(postId);
      const postOwnerId = postData[0].userId;

      if (!postData.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      if (
        !(await PostsRoutes.canModifyPostFile(
          req,
          postOwnerId,
          postData[0].projectId,
        ))
      ) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Unauthorized to update this post",
        });
      }

      const postFiles = postData[0].files || [];
      const currentFile = postFiles.find(
        (file) => file._id && file._id.toString() === fileId,
      );

      if (!currentFile) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "File not found in the post",
        });
      }

      const updateResult = await PostsHelper.updateFileUrl({
        postId,
        fileId,
        fileUrl,
        fileType,
        size,
        annotated_by: req.user._id.toString(),
        editDocument,
        // Taken from the stored file, never from the request: the pre-edit url
        // is what revert restores, so the client must not be able to point it
        // somewhere else. Ignored once originalFileUrl is already set.
        previousFileUrl: currentFile.url,
      });

      if (!updateResult) {
        return ErrorResponse(res, status.INTERNAL_SERVER_ERROR, {
          message: "Failed to update file",
        });
      }

      // The pre-edit file is deliberately NOT deleted from S3 — it is the
      // revert target. It is cleaned up when the file is permanently deleted
      // or when a revert makes the edited copy the unreferenced one.

      ProjectHelper.updateProjectInfo(postData[0].projectId);

      SuccessResponse(res, status.OK, {
        message: "File replaced successfully",
        data: {
          postId,
          fileId,
          fileUrl,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static saveFileAsCopy = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body.data, {
        postId: "string|required",
        fileId: "string|required",
        fileUrl: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { postId, fileUrl, fileId, size, fileType } = req.body.data;

      const postData = await PostsHelper.getPostData(postId);
      const postOwnerId = postData[0].userId;

      if (!postData.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      if (
        !(await PostsRoutes.canModifyPostFile(
          req,
          postOwnerId,
          postData[0].projectId,
        ))
      ) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Unauthorized to update this post",
        });
      }

      const postFiles = postData[0].files || [];
      const originalFile = postFiles.find(
        (file) => file._id && file._id.toString() === fileId,
      );

      if (!originalFile) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Original file not found in the post",
        });
      }

      delete originalFile._id;
      // A copy is a NEW photo, not an edit of the source: it must not inherit
      // the source's revert target. Sharing one originalFileUrl across two
      // files would let deleting either one orphan the other's original.
      delete originalFile.originalFileUrl;

      const updateResult = await PostsHelper.addFileCopy(postId, {
        ...originalFile,
        url: fileUrl,
        fileType,
        size,
        annotated_by: req.user._id.toString(),
      });

      if (!updateResult) {
        return ErrorResponse(res, status.INTERNAL_SERVER_ERROR, {
          message: "Failed to save file copy",
        });
      }

      ProjectHelper.updateProjectInfo(postData[0].projectId);

      SuccessResponse(res, status.OK, {
        message: "File saved as copy successfully",
        data: {
          postId,
          originalFileId: fileId,
          fileUrl,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Shared authorization for the photo-edit endpoints (replace / save-as-copy /
   * revert). The uploader can always edit their own photo. Markup of others'
   * photos (CRE-715) is open to admins, managers, and standard members of the
   * post's company (PHOTO_MARKUP_ACCESS) — but not to limited/crew roles or
   * project guests. Delete/post-edit keep their own stricter checks elsewhere.
   */
  private static canModifyPostFile = async (
    req: AuthenticatedRequest,
    postOwnerId: { toString(): string },
    projectId: string,
  ): Promise<boolean> => {
    if (postOwnerId.toString() === req.user._id.toString()) {
      return true;
    }
    const companyData = await ProjectHelper.getCompanyId(projectId);
    const [companyAdmin, userRole] = await Promise.all([
      CompanyHelpers.getCompanyAdminId(companyData.companyId),
      CompanyHelpers.getCompanyMemberRole(companyData.companyId, req.user._id),
    ]);
    return (
      req.user._id.toString() === companyAdmin.userId.toString() ||
      (!!userRole?.role && PHOTO_MARKUP_ACCESS.includes(userRole.role))
    );
  };

  /**
   * Undoes a photo edit: restores the file's pre-edit image (stored as
   * originalFileUrl when the edit was saved) and deletes the edited image from
   * S3. The file keeps its id, so its comments, notes, tags and position are
   * untouched. 409 when the file has no original to go back to — either it was
   * never edited, or it was edited before this feature shipped.
   */
  public static revertFileToOriginal = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      // The two clients disagree on envelope: web wraps post bodies in `data`
      // (like /replace), the app posts flat (like /file/description). Accept
      // either so neither has to special-case this endpoint.
      const payload = req.body?.data ?? req.body;
      const validator = new Validator(payload, {
        postId: "string|required",
        fileId: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { postId, fileId } = payload;

      if (!isValidObjectId(postId) || !isValidObjectId(fileId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid postId or fileId",
        });
      }

      const postData = await PostsHelper.getPostData(postId);

      if (!postData.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      if (
        !(await PostsRoutes.canModifyPostFile(
          req,
          postData[0].userId,
          postData[0].projectId,
        ))
      ) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Unauthorized to update this post",
        });
      }

      const revertedFrom = await PostsHelper.revertFileToOriginal({
        postId,
        fileId,
      });

      if (!revertedFrom) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "This photo has no original to revert to",
        });
      }

      // The edited image is now unreferenced.
      await fileService.deleteFromS3UsingLink(revertedFrom);

      ProjectHelper.updateProjectInfo(postData[0].projectId);

      SuccessResponse(res, status.OK, {
        message: "Photo reverted to original successfully",
        data: { postId, fileId },
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteFiles = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { files } = req.body;

      const validator = new Validator(req.body, {
        files: "array|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (!Array.isArray(files) || files.length === 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "files must be a non-empty array",
        });
      }

      // Validate structure and IDs
      for (const item of files) {
        if (!item.postId || !isValidObjectId(item.postId)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Each file must have a valid postId",
          });
        }
        if (!Array.isArray(item.fileIds) || item.fileIds.length === 0) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Each file must have a non-empty fileIds array",
          });
        }
        for (const fileId of item.fileIds) {
          if (!isValidObjectId(fileId)) {
            return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
              message: `Invalid fileId: ${fileId}`,
            });
          }
        }
      }

      // Get all unique postIds for authorization check
      const uniquePostData: string[] = [];
      files.map((f) => {
        if (!uniquePostData.includes(f.postId)) {
          uniquePostData.push(f.postId);
        }
      });

      const uniquePostIds = Array.from(
        new Set(uniquePostData.map((f) => ObjectId(f))),
      );
      const postDataArray =
        await PostsHelper.getMultiplePostsAuthData(uniquePostIds);

      if (postDataArray.length !== uniquePostIds.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "One or more posts not found",
        });
      }

      const companyData = await ProjectHelper.getCompanyId(
        postDataArray[0].projectId,
      );
      const [companyAdmin, userRole] = await Promise.all([
        CompanyHelpers.getCompanyAdminId(companyData.companyId),
        CompanyHelpers.getCompanyMemberRole(
          companyData.companyId,
          req.user._id,
        ),
      ]);

      const unauthorized = postDataArray.some((postData) => {
        const postOwnerId = postData.userId;

        return !(
          postOwnerId.toString() === req.user._id.toString() ||
          userRole?.role === USER_ROLE.MANAGER ||
          req.user._id.toString() === companyAdmin.userId.toString()
        );
      });

      if (unauthorized) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Unauthorized to update one or more posts",
        });
      }

      const result = await PostsHelper.deleteMultipleFiles(files);
      if (result.filesDeleted === 0 && result.postsDeleted === 0)
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "No matching files found to delete",
        });
      SuccessResponse(res, status.OK, {
        message: "Post file deleted successfully.",
        data: {
          filesCount: result.filesDeleted,
          postsCount: result.postsDeleted,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteUnfinalizedFiles = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { files } = req.body;

      const validator = new Validator(req.body, {
        files: "array|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (!Array.isArray(files) || !files.length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "files must be a non-empty array",
        });
      }

      for (const item of files) {
        if (!item.postId || !isValidObjectId(item.postId)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Each file must have a valid postId",
          });
        }
        if (!Array.isArray(item.fileIds) || !item.fileIds.length) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Each file must have a non-empty fileIds array",
          });
        }
        for (const fileId of item.fileIds) {
          if (!isValidObjectId(fileId)) {
            return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
              message: `Invalid fileId: ${fileId}`,
            });
          }
        }
      }

      const uniquePostData: string[] = [];
      files.map((f) => {
        if (!uniquePostData.includes(f.postId)) {
          uniquePostData.push(f.postId);
        }
      });

      const uniquePostIds = Array.from(
        new Set(uniquePostData.map((f) => ObjectId(f))),
      );
      const postDataArray =
        await PostsHelper.getMultiplePostsAuthData(uniquePostIds);

      if (postDataArray.length !== uniquePostIds.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "One or more posts not found",
        });
      }

      const companyData = await ProjectHelper.getCompanyId(
        postDataArray[0].projectId,
      );
      const [companyAdmin, userRole] = await Promise.all([
        CompanyHelpers.getCompanyAdminId(companyData.companyId),
        CompanyHelpers.getCompanyMemberRole(
          companyData.companyId,
          req.user._id,
        ),
      ]);

      const unauthorized = postDataArray.some((postData) => {
        const postOwnerId = postData.userId;
        return !(
          postOwnerId.toString() === req.user._id.toString() ||
          userRole?.role === USER_ROLE.MANAGER ||
          req.user._id.toString() === companyAdmin.userId.toString()
        );
      });

      if (unauthorized) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Unauthorized to delete one or more posts",
        });
      }

      const result = await PostsHelper.deleteUnfinalizedFiles(files);
      if (!result.filesDeleted)
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "No matching files found to delete",
        });
      SuccessResponse(res, status.OK, {
        message: "Unfinalized file(s) deleted successfully.",
        data: {
          filesCount: result.filesDeleted,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static insertFileInPost = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { postId, file } = req.body;

      const validator = new Validator(req.body, {
        postId: "string|required",
        file: "object|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (!isValidObjectId(postId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "postId is required",
        });
      }

      const postData = await PostsHelper.getPostData(postId);

      if (!postData.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      await PostsHelper.insertFileInPost(postId, file, file.position);

      ProjectHelper.updateProjectInfo(postData[0].projectId);

      return SuccessResponse(res, status.OK, {
        message: "File inserted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static insertFilesInPost = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { postId, files } = req.body;

      const validator = new Validator(req.body, {
        postId: "string|required",
        files: "array|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (!isValidObjectId(postId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid postId",
        });
      }

      if (!Array.isArray(files) || files.length === 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "files must be a non-empty array",
        });
      }

      const postData = await PostsHelper.getPostData(postId);

      if (!postData.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Post not found",
        });
      }

      await PostsHelper.insertFilesInPost(postId, files);

      ProjectHelper.updateProjectInfo(postData[0].projectId);

      return SuccessResponse(res, status.OK, {
        message: "Files inserted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static moveFileToAnotherProject = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { files, projectId } = req.body;
      const userId = req.user._id;

      // Validate top-level inputs
      const validator = new Validator(req.body, {
        files: "array|required",
        projectId: "string|required",
      });
      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (!Array.isArray(files) || files.length === 0) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "files must be a non-empty array",
        });
      }

      if (!isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid projectId",
        });
      }

      // Validate file structure
      for (const item of files) {
        if (!item.postId || !isValidObjectId(item.postId)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Each file must have a valid postId",
          });
        }
        if (!Array.isArray(item.fileIds) || item.fileIds.length === 0) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Each file must have a non-empty fileIds array",
          });
        }
        for (const fileId of item.fileIds) {
          if (!isValidObjectId(fileId)) {
            return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
              message: `Invalid fileId: ${fileId}`,
            });
          }
        }
      }

      // Fetch target project + all posts in parallel
      const uniquePostIds = Array.from(
        new Set(files.map((f) => f.postId.toString())),
      ).map((id) => ObjectId(id));
      const [targetProject, allPosts] = await Promise.all([
        ProjectHelper.getProjectData(projectId),
        PostsHelper.getPostsByIds(uniquePostIds),
      ]);

      if (!targetProject) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Target project not found",
        });
      }
      if (allPosts.length !== uniquePostIds.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "One or more posts not found",
        });
      }

      // Authorization check
      const companyData = await ProjectHelper.getCompanyId(
        allPosts[0].projectId,
      );
      const [companyAdmin, userRole] = await Promise.all([
        CompanyHelpers.getCompanyAdminId(companyData.companyId),
        CompanyHelpers.getCompanyMemberRole(companyData.companyId, userId),
      ]);

      const unauthorized = allPosts.some((postData) => {
        return !(
          postData.userId.toString() === userId.toString() ||
          userRole?.role === USER_ROLE.MANAGER ||
          userId.toString() === companyAdmin.userId.toString()
        );
      });

      if (unauthorized) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Unauthorized to move files from one or more posts",
        });
      }

      // Collect unique source project IDs for project info update
      const sourceProjectIds = Array.from(
        new Set(allPosts.map((p) => p.projectId.toString())),
      );

      const result = await PostsHelper.moveFilesToProject(
        userId,
        projectId,
        companyData.companyId,
        files,
        sourceProjectIds,
      );

      return SuccessResponse(res, status.OK, {
        message: "Files moved successfully",
        data: result,
      });
    } catch (error: any) {
      if (error?.status) {
        return ErrorResponse(res, error.status, {
          message: error.message,
        });
      }
      next(error);
    }
  };
}
