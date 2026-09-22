import {
  Posts,
  Project,
  Report,
  User,
  DeletedPostFiles,
  PostFiles,
} from "../../db";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import { SORT_TYPE } from "../../utils/enums/post";
import {
  getProjectNamePipeline,
  isValidObjectId,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import {
  getOnlyBasicUserDetails,
  getPostNote,
} from "../../utils/helpers/lookUpHelpers";
import { isAdminUser } from "../../utils/helpers/users";
import {
  IReplaceOriginalFile,
  IRevertFileToOriginal,
  PostType,
  DeletedPostFileDocument,
  FileType,
  UploadsFile,
  UploadsRow,
  UploadsPathResult,
  UploadsFileMatch,
  UploadsScopeUser,
  UploadsGridRow,
  UploadsProjectName,
} from "../../utils/interfaces/post";
import {
  buildPostsUploadsQuery,
  SearchClientService,
  POSTS_UPLOADS_REQUEST_TIMEOUT_MS,
} from "../../search";
import { PostsUploadsQueryInput } from "../../search/types/queries";
import {
  MyUploadsQuery,
  PaginatedSearchQuery,
  ProjectScrollQuery,
} from "../../utils/interfaces/query";
import {
  CompaniesType,
  ObjectIdType,
  ReportType,
} from "../../utils/interfaces/schemaInterface";
import { ProjectHelper } from "../projects/helper";
import { PipelineStage, Types } from "mongoose";
import {
  getCachedUploadsTotal,
  invalidatePostsUploadsCache,
  invalidatePostsUploadsCacheByPostId,
} from "../../services/redis/postCache";
import { fileService } from "../../services/awsBucket";
import { mediaVariantsService } from "../../services/mediaVariants";

type mongoId = Types.ObjectId | string;

// Minimal posts_uploads ES hit shape read by the ES read path; the client's generated `HitsMetadata.hits` type is malformed (`Hit & {_source?: T}[]` with an unbound `T`), so we cast to this. With collapse:{field:postId}, each hit is one POST (its top file by the sort).
interface EsUploadHit {
  _id?: string;
  _source?: { postId?: string; userId?: string };
}

// Lean projections for the batched hydration queries.
interface LeanPostFile {
  _id: ObjectIdType;
  postId: ObjectIdType;
  url?: string;
  fileType?: string;
  uploadedAt?: Date;
  size?: { width?: number; height?: number };
  location?: { long?: number; lat?: number };
  tags?: ObjectIdType[];
  note?: string;
  description?: string;
  timestamp?: Date;
  position?: number;
  commentCount?: number;
  createdAt?: Date;
}
interface LeanUserBasic {
  _id: ObjectIdType;
  name?: { first?: string; last?: string };
  profileImage?: string;
}

// Shared $lookup stage that attaches active PostFiles to a Post document in
// aggregation pipelines, mirroring the previous embedded array shape.
const postFilesLookupStage = {
  $lookup: {
    from: "postfiles",
    let: { postId: "$_id" },
    pipeline: [
      {
        $match: {
          $expr: { $eq: ["$postId", "$$postId"] },
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      { $sort: { position: 1 as const, createdAt: 1 as const } },
    ],
    as: "files",
  },
};

// 60s in-process memo for the uploads-v2 non-admin project scoping:
// getMineAndCompanyProjects costs >1s on companies with thousands of
// projects and its result changes rarely (membership/archive edits), so a
// short memo bounds that cost to once per user per minute per instance.
// Staleness window matches the uploads count cache.
type ProjectScope = Awaited<
  ReturnType<typeof ProjectHelper.getMineAndCompanyProjects>
>;
const projectScopeCache = new Map<
  string,
  { value: ProjectScope; expiresAt: number }
>();
const PROJECT_SCOPE_TTL_MS = 60 * 1000;
const PROJECT_SCOPE_CACHE_MAX = 1000;

const getProjectScopeMemoized = async (
  companyIds: ObjectIdType[],
  userId: ObjectIdType,
): Promise<ProjectScope> => {
  const key = `${userId}:${companyIds.map(String).join(",")}`;
  const hit = projectScopeCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  const scope = await ProjectHelper.getMineAndCompanyProjects(
    companyIds as Types.ObjectId[],
    userId as Types.ObjectId,
  );
  // Don't memoize empty scopes: getMineAndCompanyProjects returns [] on
  // error, and pinning that for 60s would blank the user's feed.
  if (scope.projectIds.length) {
    if (projectScopeCache.size >= PROJECT_SCOPE_CACHE_MAX) {
      const now = Date.now();
      projectScopeCache.forEach(({ expiresAt }, k) => {
        if (expiresAt < now) projectScopeCache.delete(k);
      });
      if (projectScopeCache.size >= PROJECT_SCOPE_CACHE_MAX) {
        projectScopeCache.clear();
      }
    }
    projectScopeCache.set(key, {
      value: scope,
      expiresAt: Date.now() + PROJECT_SCOPE_TTL_MS,
    });
  }
  return scope;
};

const filesObject = {
  _id: "$_id",
  url: "$url",
  fileType: "$fileType",
  uploadedAt: "$uploadedAt",
  size: "$size",
  location: "$location",
  tags: "$tags",
  note: "$note",
  description: "$description",
  quickView: "$quickView",
  thumbnail: "$thumbnail",
  timestamp: "$timestamp",
  annotated_by: "$annotated_by",
  position: "$position",
  noteCount: "$noteCount",
  userId: "$userId",
  createdAt: "$createdAt",
  originalUri: "$originalUri",
  originalFileUrl: "$originalFileUrl",
  editDocument: "$editDocument",
};

export class PostsHelper {
  public static create = async (
    userId: mongoId,
    body: PostType,
    companyId: ObjectIdType,
  ) => {
    const { projectId, note, files } = body;

    const post = await Posts.create({
      userId,
      projectId,
      note,
      companyId,
      totalFiles: files?.length || 0,
    });

    if (Array.isArray(files) && files.length) {
      const createdFiles = await PostFiles.insertMany(
        files.map((file, idx) => ({
          ...file,
          postId: post._id,
          companyId: post.companyId,
          projectId: post.projectId,
          userId: post.userId,
          position: typeof file.position === "number" ? file.position : idx,
        })),
      );
      // After-task: video thumbnails / image quickViews generate in the
      // background without delaying post creation.
      mediaVariantsService.enqueueCandidates(createdFiles);

      await invalidatePostsUploadsCache(companyId);

      return {
        ...post.toObject(),
        files: createdFiles,
      };
    }

    await invalidatePostsUploadsCache(companyId);

    // Shape-stable return: callers always get a plain object with a files
    // array, whether or not the post had media.
    return {
      ...post.toObject(),
      files: [],
    };
  };

  public static createNow = async (body: any) => {
    const { files, ...postBody } = body;
    const post = await Posts.create({
      ...postBody,
      totalFiles: files?.length || 0,
    });

    if (Array.isArray(files) && files.length) {
      const createdFiles = await PostFiles.insertMany(
        files.map((file, idx) => ({
          ...file,
          postId: post._id,
          companyId: post.companyId,
          projectId: post.projectId,
          userId: post.userId,
          position: typeof file.position === "number" ? file.position : idx,
        })),
      );
      mediaVariantsService.enqueueCandidates(createdFiles);
    }

    await invalidatePostsUploadsCache(post.companyId);

    return post;
  };

  public static findAll = async (
    userId: Types.ObjectId,
    companies: CompaniesType[],
    query: any,
    role: string,
  ) => {
    const userDetailsLookUp = getOnlyBasicUserDetails();
    const getPostNoteLookUp = getPostNote();

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skips = (page - 1) * limit;

    const companyIds = companies.map((c) => c.companyId);
    const additionalParameters = {};
    if (query.filterProjectTags) {
      additionalParameters["tags"] = {
        $in: JSON.parse(query.filterProjectTags).map((tag) => ObjectId(tag)),
      };
    }
    const { projectIds } = await ProjectHelper.getMineAndCompanyProjects(
      companyIds,
      userId,
      additionalParameters,
    );

    const matchQuery: any = {
      companyId: companyIds[0],
      status: CURRENT_STATUS.ACTIVE,
    };

    if (query?.dateRange) {
      matchQuery.createdAt = {
        $gte: new Date(query.dateRange.startDate),
        $lte: new Date(query.dateRange.endDate),
      };
    }

    if (query.filterProjects) {
      const filterProjects = JSON.parse(query.filterProjects);
      if (filterProjects?.length) {
        matchQuery.projectId = {
          $in: filterProjects.map((user) => ObjectId(user)),
        };
      }
    } else if (query.projectId) {
      matchQuery.projectId = ObjectId(query.projectId);
    } else if (role && !isAdminUser(role)) {
      matchQuery.projectId = { $in: projectIds };
    }

    if (query.filterUsers) {
      const filterUsers = JSON.parse(query.filterUsers);
      if (filterUsers?.length) {
        matchQuery.userId = { $in: filterUsers.map((user) => ObjectId(user)) };
      }
    } else if (query.userId) {
      matchQuery.userId = ObjectId(query.userId);
    }

    let searchFileOr: Record<string, unknown>[] | null = null;
    if (query.postId) {
      const { postIds, fileOr } = await PostsHelper.buildSearchMatch(
        query.postId,
        matchQuery,
      );
      if (postIds.length === 0) {
        return [
          [{ items: [], total: 0, page, pageSize: limit, totalPages: 0 }],
          [],
        ];
      }

      matchQuery.postId = { $in: postIds };
      searchFileOr = fileOr;
    }

    if (query.filterPostTags) {
      const filterTags = JSON.parse(query.filterPostTags);
      if (filterTags.length) {
        const tagIds = filterTags.map((tag) => ObjectId(tag));
        matchQuery.tags = { $in: tagIds };
      }
    }

    const createdOrder: 1 | -1 =
      query?.sortBy === SORT_TYPE.OLDEST ||
      query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC
        ? 1
        : -1;

    const sortByTimestamp =
      query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
      query?.sortBy === SORT_TYPE.DATE_TAKEN_DESC;

    let total;
    let items;

    const fileMatch = searchFileOr
      ? { ...matchQuery, $or: searchFileOr }
      : matchQuery;

    if (sortByTimestamp) {
      [total, items] = await Promise.all([
        PostFiles.aggregate([{ $match: fileMatch }, { $count: "total" }]),
        PostFiles.aggregate(
          [
            { $match: fileMatch },
            {
              $addFields: {
                sortTimestamp: { $ifNull: ["$timestamp", "$createdAt"] },
              },
            },
            {
              $sort: {
                sortTimestamp: createdOrder,
                createdAt: createdOrder,
              },
            },
            { $skip: skips },
            { $limit: limit },
            {
              $lookup: {
                from: "projects",
                localField: "projectId",
                foreignField: "_id",
                pipeline: [{ $project: { name: 1 } }],
                as: "projectInfo",
              },
            },
            ...userDetailsLookUp,
            ...getPostNoteLookUp,
            {
              $project: {
                _id: "$postId",
                userId: 1,
                note: 1,
                files: [filesObject],
                createdAt: "$sortTimestamp",
                projectId: 1,
                userName: 1,
                profileImage: 1,
                projectName: 1,
              },
            },
          ],
          { allowDiskUse: true },
        ),
      ]);
    } else {
      const { tags, postId, ...postsBase } = matchQuery;
      const postsMatch: any = { ...postsBase };

      let tagPostIds: any[] | null = null;
      if (tags) {
        tagPostIds = await PostFiles.distinct("postId", {
          companyId: matchQuery.companyId,
          status: CURRENT_STATUS.ACTIVE,
          tags,
          ...(matchQuery.projectId ? { projectId: matchQuery.projectId } : {}),
          ...(matchQuery.userId ? { userId: matchQuery.userId } : {}),
        });
      }

      if (postId && tagPostIds) {
        // Note-search ids ∩ tag-matched ids.
        const tagSet = new Set(tagPostIds.map((id) => id.toString()));
        postsMatch._id = {
          $in: (postId.$in || []).filter((id: any) =>
            tagSet.has(id.toString()),
          ),
        };
      } else if (postId) {
        postsMatch._id = postId;
      } else if (tagPostIds) {
        postsMatch._id = { $in: tagPostIds };
      }

      const [count, postItems] = await Promise.all([
        Posts.countDocuments(postsMatch),
        Posts.aggregate(
          [
            { $match: postsMatch },
            { $sort: { createdAt: createdOrder } },
            { $skip: skips },
            { $limit: limit },
            {
              $lookup: {
                from: "postfiles",
                let: { pid: "$_id" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ["$postId", "$$pid"] },
                      status: CURRENT_STATUS.ACTIVE,
                      ...(searchFileOr ? { $or: searchFileOr } : {}),
                    },
                  },
                  { $sort: { position: 1 as const, createdAt: 1 as const } },
                  { $project: filesObject },
                ],
                as: "files",
              },
            },
            ...userDetailsLookUp,
            {
              $project: {
                userId: 1,
                note: 1,
                files: 1,
                createdAt: 1,
                projectId: 1,
                userName: 1,
                profileImage: 1,
              },
            },
          ],
          { allowDiskUse: true },
        ),
      ]);
      total = [{ total: count }];
      items = postItems;
    }

    const data = [
      {
        items,
        total,
        page,
        pageSize: limit,
        totalPages: Math.ceil((total[0]?.total || 0) / limit),
      },
    ];

    const opProjectIds = projectIds.map((p) => p.toString());

    return [data, opProjectIds];
  };

  private static buildSearchMatch = async (
    search: string,
    scope: Record<string, unknown> | UploadsFileMatch,
  ): Promise<{
    notePostIds: ObjectIdType[];
    postIds: ObjectIdType[];
    fileOr: Record<string, unknown>[];
  }> => {
    const regex = { $regex: search, $options: "i" };
    const [notePostIds, descPostIds] = await Promise.all([
      Posts.distinct("_id", {
        note: regex,
        status: CURRENT_STATUS.ACTIVE,
        ...scope,
      }) as Promise<ObjectIdType[]>,
      PostFiles.distinct("postId", {
        description: regex,
        status: CURRENT_STATUS.ACTIVE,
        ...scope,
      }) as Promise<ObjectIdType[]>,
    ]);

    const seen = new Set(notePostIds.map((id) => id.toString()));
    const postIds = [...notePostIds];
    for (const id of descPostIds) {
      if (!seen.has(id.toString())) {
        seen.add(id.toString());
        postIds.push(id);
      }
    }

    return {
      notePostIds,
      postIds,
      fileOr: [{ postId: { $in: notePostIds } }, { description: regex }],
    };
  };

  // The PostFiles match behind every uploads read — the list, and the file
  // counts derived from it. Extracted so a count can be taken without running
  // the list aggregation, and so the two can never disagree about which files a
  // given filter set selects. Returns null when a text search matches no post
  // at all, which is the caller's empty-result signal (no files can match).
  private static buildUploadsMatch = async (
    query: PaginatedSearchQuery & MyUploadsQuery,
    user?: UploadsScopeUser,
  ): Promise<UploadsFileMatch | null> => {
    const { projectId, userId, filterUsers, filterProjects, filterPostTags } =
      query;

    // Derive companyId from the target project when a projectId is supplied
    // (covers shared-project links: anyone with the link can view, including
    // unauthenticated users and users from a different company). Falls back
    // to the logged-in user's company when no projectId is given.
    let scopedCompanyId: ObjectIdType | undefined = user?.companyIds?.[0];
    if (projectId) {
      const project = await ProjectHelper.getCompanyId(projectId);
      if (project?.companyId) {
        scopedCompanyId = project.companyId as ObjectIdType;
      }
    }

    const matchQuery: UploadsFileMatch = {
      status: CURRENT_STATUS.ACTIVE,
    };

    if (scopedCompanyId) {
      matchQuery.companyId = scopedCompanyId;
    }

    if (query?.dateRange) {
      matchQuery.createdAt = {
        $gte: new Date(query.dateRange.startDate),
        $lte: new Date(query.dateRange.endDate),
      };
    }

    if (filterProjects) {
      const filteredProjectsArray = JSON.parse(filterProjects);
      if (filteredProjectsArray?.length) {
        matchQuery.projectId = {
          $in: filteredProjectsArray.map((user) => ObjectId(user)),
        };
      }
    } else if (projectId) {
      matchQuery.projectId = ObjectId(projectId);
    } else if (user?.role && !isAdminUser(user?.role)) {
      const { projectIds } = await ProjectHelper.getMineAndCompanyProjects(
        user?.companyIds ?? [],
        user?.userId,
      );
      matchQuery.projectId = { $in: projectIds };
    }

    if (filterUsers) {
      const filteredUsersArray = JSON.parse(filterUsers);
      if (filteredUsersArray?.length) {
        matchQuery.userId = {
          $in: filteredUsersArray.map((user) => ObjectId(user)),
        };
      }
    } else if (userId) {
      matchQuery.userId = ObjectId(userId);
    }

    if (query.postId) {
      const { postIds, fileOr } = await PostsHelper.buildSearchMatch(
        query.postId,
        matchQuery,
      );
      if (postIds.length === 0) {
        return null;
      }
      matchQuery.$or = fileOr;
    }

    if (filterPostTags) {
      const filterTags = JSON.parse(filterPostTags);
      if (filterTags.length) {
        matchQuery.tags = { $in: filterTags.map((tag) => ObjectId(tag)) };
      }
    }

    return matchQuery;
  };

  // ACTIVE file count for an uploads query — the same unit as the Uploads tab
  // badge (getProjectPhotoCount), under the caller's filters. Counting straight
  // off the shared match keeps it a single index-backed countDocuments instead
  // of running the list aggregation just to read its total.
  public static countUploadFiles = async (
    query: PaginatedSearchQuery & MyUploadsQuery,
    user?: UploadsScopeUser,
  ): Promise<number> => {
    const matchQuery = await PostsHelper.buildUploadsMatch(query, user);
    if (!matchQuery) {
      return 0;
    }
    return PostFiles.countDocuments(matchQuery);
  };

  public static findAllUploads = async (
    query: PaginatedSearchQuery & MyUploadsQuery,
    user?: UploadsScopeUser,
  ) => {
    const { page, skips, pageSize } = query;

    const userDetailsLookUp = getOnlyBasicUserDetails();
    const getPostNoteLookUp = getPostNote();

    const matchQuery = await PostsHelper.buildUploadsMatch(query, user);

    // Null match = the text search hit no post at all, so no file can match.
    if (!matchQuery) {
      return [
        { items: [], total: 0, totalFiles: 0, page, pageSize, totalPages: 0 },
      ];
    }

    const createdOrder: 1 | -1 =
      query?.sortBy === SORT_TYPE.OLDEST ||
      query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC
        ? 1
        : -1;

    const sortByTimestamp =
      query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
      query?.sortBy === SORT_TYPE.DATE_TAKEN_DESC;

    // Two numbers are needed: `files` feeds the Uploads badge (file units, the
    // same unit as getProjectPhotoCount) and `pageUnit` is what this path
    // paginates by — files when sorting by timestamp, distinct posts otherwise.
    // Sorting by timestamp makes them identical, so that branch stays a plain
    // countDocuments; the post-collapsed branch has to stream the match for its
    // $group anyway, so one $facet gets both numbers in that same single pass.
    // $count emits nothing on an empty match, hence the `?? 0` reads.
    const countsPromise: Promise<{ files: number; pageUnit: number }> =
      sortByTimestamp
        ? PostFiles.countDocuments(matchQuery).then((files) => ({
            files,
            pageUnit: files,
          }))
        : PostFiles.aggregate<{
            files: { total: number }[];
            posts: { total: number }[];
          }>([
            { $match: matchQuery },
            {
              $facet: {
                files: [{ $count: "total" }],
                posts: [{ $group: { _id: "$postId" } }, { $count: "total" }],
              },
            },
          ]).then((result) => ({
            files: result[0]?.files?.[0]?.total ?? 0,
            pageUnit: result[0]?.posts?.[0]?.total ?? 0,
          }));

    const [counts, items] = await Promise.all([
      countsPromise,
      PostFiles.aggregate(
        [
          { $match: matchQuery },
          ...(sortByTimestamp
            ? [
                {
                  $addFields: {
                    sortTimestamp: { $ifNull: ["$timestamp", "$createdAt"] },
                  },
                },
                {
                  $sort: {
                    sortTimestamp: createdOrder,
                    createdAt: createdOrder,
                  },
                },
                { $skip: skips },
                { $limit: pageSize },
              ]
            : [{ $sort: { position: 1 as const } }]),
          {
            $group: {
              _id: "$postId",
              postId: { $first: "$postId" },
              userId: { $first: "$userId" },
              files: {
                $push: {
                  url: "$url",
                  fileType: "$fileType",
                  uploadedAt: "$uploadedAt",
                  size: "$size",
                  location: "$location",
                  tags: "$tags",
                  note: "$note",
                  description: "$description",
                  timestamp: "$timestamp",
                  _id: "$_id",
                  fileIndex: "$fileIndex",
                  noteCount: "$commentCount",
                },
              },
              postCreatedAt: { $min: "$createdAt" },
            },
          },
          ...(sortByTimestamp
            ? []
            : [
                { $sort: { postCreatedAt: createdOrder } },
                { $skip: skips },
                { $limit: pageSize },
              ]),
          ...getPostNoteLookUp,
          ...userDetailsLookUp,
          {
            $project: {
              profileImage: 1,
              userName: 1,
              files: 1,
              createdAt: "$postCreatedAt",
              userId: 1,
            },
          },
        ],
        { allowDiskUse: true },
      ),
    ]);

    const { files: totalFiles, pageUnit: pageUnitTotal } = counts;

    return [
      {
        items,
        total: [{ total: pageUnitTotal }],
        totalFiles,
        page,
        pageSize,
        totalPages: Math.ceil(pageUnitTotal / pageSize),
      },
    ];
  };

  // Batched file hydration for the ES uploads path: all ACTIVE PostFiles for the page's posts in ONE query, grouped by postId (position-sorted), mapped to findAllUploads' files[] shape + postCreatedAt = min(createdAt) per post. NOTE: `fileIndex` is intentionally omitted — findAllUploads' $push references a non-existent `$fileIndex`, so Mongo omits it.
  public static getPostFilesByPostIdsBatch = async (
    companyId: ObjectIdType,
    postIds: ObjectIdType[],
  ): Promise<
    Record<string, { files: UploadsFile[]; postCreatedAt?: Date }>
  > => {
    if (!postIds.length) {
      return {};
    }
    const rows = (await PostFiles.find(
      { postId: { $in: postIds }, companyId, status: CURRENT_STATUS.ACTIVE },
      {
        postId: 1,
        url: 1,
        fileType: 1,
        uploadedAt: 1,
        size: 1,
        location: 1,
        tags: 1,
        note: 1,
        description: 1,
        timestamp: 1,
        position: 1,
        commentCount: 1,
        createdAt: 1,
      },
    )
      .sort({ position: 1 })
      .lean()) as unknown as LeanPostFile[];

    const map: Record<string, { files: UploadsFile[]; postCreatedAt?: Date }> =
      {};
    rows.forEach((f) => {
      const key = f.postId.toString();
      if (!map[key]) {
        map[key] = { files: [], postCreatedAt: f.createdAt };
      }
      map[key].files.push({
        _id: f._id,
        url: f.url,
        fileType: f.fileType,
        uploadedAt: f.uploadedAt,
        size: f.size,
        location: f.location,
        tags: f.tags,
        note: f.note,
        description: f.description,
        timestamp: f.timestamp ?? null,
        noteCount: f.commentCount,
      });
      if (
        f.createdAt &&
        (!map[key].postCreatedAt || f.createdAt < map[key].postCreatedAt)
      ) {
        map[key].postCreatedAt = f.createdAt;
      }
    });
    return map;
  };

  // Batched user lookup for the ES uploads path — mirrors getOnlyBasicUserDetails: userName = "first last" (null if either part is missing), profileImage from the user.
  public static getBasicUserDetailsBatch = async (
    userIds: ObjectIdType[],
  ): Promise<
    Record<string, { userName: string | null; profileImage: string | null }>
  > => {
    if (!userIds.length) {
      return {};
    }
    const users = (await User.find(
      { _id: { $in: userIds } },
      { "name.first": 1, "name.last": 1, profileImage: 1 },
    ).lean()) as unknown as LeanUserBasic[];

    const map: Record<
      string,
      { userName: string | null; profileImage: string | null }
    > = {};
    users.forEach((u) => {
      const first = u.name?.first;
      const last = u.name?.last;
      map[u._id.toString()] = {
        profileImage: u.profileImage ?? null,
        userName: first != null && last != null ? `${first} ${last}` : null,
      };
    });
    return map;
  };

  // ES read path for GET /api/posts/uploads (list mode only). Builds the query via buildPostsUploadsQuery, augments it with collapse:{field:postId} (post-level pagination, to match the Mongo post-grouped feed) + a distinct-post cardinality agg (precision_threshold 40000 → exact distinct-post count up to 40k, beyond which cardinality is an HLL approximation; Mongo's $count is always exact — residual drift above 40k is a parity nuance), then hydrates file bodies + user fields from Mongo in 2 batched queries (no per-row fan-out). Returns findAllUploads' exact `[{ items, total: [{ total }], page, pageSize, totalPages }]` shape, so the handler's date-bucketing runs unchanged. GUEST/grid/external/timestamp-sort never reach here (handler routes them to Mongo).
  public static getUploadsFromES = async (
    input: PostsUploadsQueryInput,
  ): Promise<UploadsPathResult> => {
    const base = buildPostsUploadsQuery(input);
    const searchReq = {
      ...base,
      body: {
        ...(base.body ?? {}),
        collapse: { field: "postId" },
        aggregations: {
          distinctPosts: {
            cardinality: { field: "postId", precision_threshold: 40000 },
          },
        },
      },
    } as unknown as typeof base;

    const response = await SearchClientService.getInstance().search(searchReq, {
      requestTimeout: POSTS_UPLOADS_REQUEST_TIMEOUT_MS,
    });
    const hitsMeta = response?.body?.hits;
    if (!hitsMeta || !Array.isArray(hitsMeta.hits)) {
      throw new Error("Malformed OpenSearch response: missing hits");
    }
    const hits = hitsMeta.hits as unknown as EsUploadHit[];
    const aggs = response.body.aggregations as
      { distinctPosts?: { value?: number } } | undefined;
    const totalRaw = hitsMeta.total;
    const fallbackTotal =
      typeof totalRaw === "number" ? totalRaw : (totalRaw?.value ?? 0);
    const totalCount = aggs?.distinctPosts?.value ?? fallbackTotal;

    const postIds = hits
      .map((h) => h._source?.postId)
      .filter((id): id is string => Boolean(id));
    const userIds = Array.from(
      new Set(
        hits
          .map((h) => h._source?.userId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const [filesByPost, usersById] = await Promise.all([
      PostsHelper.getPostFilesByPostIdsBatch(
        input.companyId,
        postIds.map((id) => ObjectId(id)),
      ),
      PostsHelper.getBasicUserDetailsBatch(userIds.map((id) => ObjectId(id))),
    ]);

    // Build a row per collapsed post. Skip hits with no postId, and skip posts that have no ACTIVE PostFiles in Mongo (index lag / files soft-deleted after indexing): the Mongo feed IS PostFiles, so it never emits a postless row — and an undefined createdAt would poison the handler's date-bucketing. Matches findAllUploads.
    const items: UploadsRow[] = hits
      .map((hit): UploadsRow | null => {
        const postId = (hit._source?.postId ?? "").toString();
        if (!postId) {
          return null;
        }
        const grouped = filesByPost[postId];
        if (!grouped || !grouped.files.length) {
          return null;
        }
        const uid = (hit._source?.userId ?? "").toString();
        const userDetails = usersById[uid] ?? {
          userName: null,
          profileImage: null,
        };
        return {
          _id: postId,
          userId: uid,
          userName: userDetails.userName,
          profileImage: userDetails.profileImage,
          createdAt: grouped.postCreatedAt,
          files: grouped.files,
        };
      })
      .filter((row): row is UploadsRow => row !== null);

    return [
      {
        items,
        total: [{ total: totalCount }],
        // hits.total counts matched documents (files) — collapse only groups the
        // returned hits, so this is the file-unit sibling of distinctPosts.
        totalFiles: fallbackTotal,
        page: input.page,
        pageSize: input.pageSize,
        totalPages: Math.ceil(totalCount / input.pageSize),
      },
    ];
  };

  public static findRecentUploads = async (
    query: PaginatedSearchQuery & MyUploadsQuery,
  ) => {
    const { projectId, userId, postId } = query;

    const fileLimit = Number(query.limit) || 9;

    const matchQuery: any = {
      status: CURRENT_STATUS.ACTIVE,
    };

    if (projectId) {
      matchQuery.projectId = ObjectId(projectId);
    }

    if (userId) {
      matchQuery.userId = ObjectId(userId);
    }

    if (postId) {
      const { postIds, fileOr } = await PostsHelper.buildSearchMatch(
        postId,
        matchQuery,
      );
      if (postIds.length === 0) {
        return [{ items: [], total: 0 }];
      }
      matchQuery.$or = fileOr;
    }

    const userDetailsLookUp = getOnlyBasicUserDetails();
    const getPostNoteLookUp = getPostNote();

    const sortBy = query.sortBy || SORT_TYPE.DATE_TAKEN_DESC;
    const createdOrder: 1 | -1 =
      sortBy === SORT_TYPE.OLDEST || sortBy === SORT_TYPE.DATE_TAKEN_ASC
        ? 1
        : -1;
    const sortByTimestamp =
      sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
      sortBy === SORT_TYPE.DATE_TAKEN_DESC;

    const sortSpec: Record<string, 1 | -1> = sortByTimestamp
      ? { sortTimestamp: createdOrder, createdAt: createdOrder }
      : { postId: -1, position: 1 };
    const timestampFallbackStage = sortByTimestamp
      ? [
          {
            $addFields: {
              sortTimestamp: { $ifNull: ["$timestamp", "$createdAt"] },
            },
          },
        ]
      : [];

    const contiguousIndex = { $subtract: ["$fileRank", 1] };

    const [totalResult, items] = await Promise.all([
      PostFiles.countDocuments(matchQuery),
      PostFiles.aggregate(
        [
          { $match: matchQuery },
          {
            $setWindowFields: {
              partitionBy: "$postId",
              sortBy: { position: 1 as const },
              output: { fileRank: { $documentNumber: {} } },
            },
          },
          ...timestampFallbackStage,
          { $sort: sortSpec },
          { $limit: fileLimit },
          ...userDetailsLookUp,
          ...getPostNoteLookUp,
          {
            $project: {
              _id: "$postId",
              profileImage: 1,
              userName: 1,
              note: { $arrayElemAt: ["$postInfo.note", 0] },
              noteCount: "$commentCount",
              files: { ...filesObject, fileIndex: contiguousIndex },
              fileIndex: contiguousIndex,
              ...(sortByTimestamp
                ? {}
                : {
                    totalFiles: { $arrayElemAt: ["$postInfo.totalFiles", 0] },
                  }),
              createdAt: 1,
              userId: 1,
            },
          },
        ],
        { allowDiskUse: true },
      ),
    ]);

    return [
      {
        items,
        total: totalResult,
      },
    ];
  };

  public static getPostData = async (postId: string) => {
    if (!postId || !isValidObjectId(postId)) {
      return [];
    }
    const projectNamePipeline = getProjectNamePipeline();

    const userDetailsLookUp = getOnlyBasicUserDetails();
    const getPostNoteLookUp = getPostNote();

    return PostFiles.aggregate([
      {
        $match: {
          postId: ObjectId(postId),
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      {
        $group: {
          _id: "$postId",
          userId: {
            $first: "$userId",
          },
          projectId: { $first: "$projectId" },

          files: {
            $push: {
              url: "$url",
              fileType: "$fileType",
              uploadedAt: "$uploadedAt",
              size: "$size",
              location: "$location",
              tags: "$tags",
              timestamp: "$timestamp",
              _id: "$_id",
              fileIndex: "$fileIndex",
              noteCount: "$commentCount",
            },
          },
        },
      },
      ...userDetailsLookUp,
      ...projectNamePipeline,
      ...getPostNoteLookUp,
      {
        $project: {
          userId: 1,
          note: 1,
          files: 1,
          createdAt: 1,
          projectId: 1,
          userName: 1,
          profileImage: 1,
          projectName: 1,
        },
      },
    ]);
  };

  public static getPostsById = async (postId: ObjectIdType) => {
    return Posts.aggregate([
      { $match: { _id: postId, status: CURRENT_STATUS.ACTIVE } },
      postFilesLookupStage,
      { $project: { userId: 1, projectId: 1, files: 1 } },
    ]);
  };

  public static getMultiplePostsAuthData = async (postIds: ObjectIdType[]) => {
    if (!postIds || postIds.length === 0) {
      return [];
    }

    const response = await Posts.aggregate([
      {
        $match: {
          _id: { $in: postIds },
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      {
        $project: {
          userId: 1,
          projectId: 1,
        },
      },
    ]);
    return response;
  };

  public static getPostsByIds = async (postIds: ObjectIdType[]) => {
    if (!postIds || postIds.length === 0) {
      return [];
    }
    return Posts.aggregate([
      {
        $match: { _id: { $in: postIds }, status: CURRENT_STATUS.ACTIVE },
      },
      postFilesLookupStage,
      {
        $project: {
          files: 1,
          projectId: 1,
          userId: 1,
        },
      },
    ]);
  };

  public static getSearchRecommendation = (
    search: string,
    companyMembers: mongoId[],
    projectIds: mongoId[],
    companyId: mongoId,
  ) => {
    return Promise.all([
      Posts.aggregate([
        {
          $match: {
            note: {
              $regex: search,
              $options: "i",
            },
            status: CURRENT_STATUS.ACTIVE,
            companyId,
            projectId: { $in: projectIds },
          },
        },
        {
          $project: {
            value: "$note",
            source: "postId",
          },
        },
        {
          $limit: 5,
        },
      ]),
      User.aggregate([
        {
          $match: {
            _id: { $in: companyMembers },
          },
        },
        {
          $addFields: {
            userName: { $concat: ["$name.first", " ", "$name.last"] },
          },
        },
        {
          $match: {
            userName: {
              $regex: search,
              $options: "i",
            },
          },
        },
        {
          $project: {
            value: "$userName",
            source: "userId",
          },
        },
        {
          $limit: 5,
        },
      ]),
      Project.aggregate([
        {
          $match: {
            companyId,
            _id: { $in: projectIds },
            name: {
              $regex: search,
              $options: "i",
            },
          },
        },
        {
          $project: {
            value: "$name",
            source: "projectId",
            location: "$location",
          },
        },
        {
          $limit: 5,
        },
      ]),
      Project.aggregate([
        {
          $match: {
            companyId,
            _id: { $in: projectIds },
            location: {
              $regex: search,
              $options: "i",
            },
          },
        },
        {
          $sort: {
            createdAt: -1,
          },
        },
        {
          $project: {
            value: "$name",
            location: "$location",
            source: "projectId",
          },
        },
        {
          $limit: 5,
        },
      ]),
      PostFiles.aggregate([
        {
          $match: {
            description: {
              $regex: search,
              $options: "i",
            },
            status: CURRENT_STATUS.ACTIVE,
            companyId,
            projectId: { $in: projectIds },
          },
        },
        {
          $project: {
            value: "$description",
            source: "postId",
            matchedOn: "description",
          },
        },
        {
          $limit: 5,
        },
      ]),
    ]);
  };

  public static reportPost = (
    user: { _id: mongoId; name: { first: string; last: string } },
    body: ReportType,
  ) => {
    return Report.create({
      ...body,
      createdBy: user._id,
      creatorName: user?.name?.first + " " + user?.name?.last,
    });
  };

  public static deletePost = async (postId: string) => {
    const result = await Posts.findByIdAndUpdate(postId, {
      $set: { status: CURRENT_STATUS.DELETED },
    });
    // Soft-delete the post's files too. The uploads listing matches on
    // PostFiles.status (ACTIVE), not Post.status, so leaving them ACTIVE keeps
    // them visible. They stay in postfiles as DELETED so the bin
    // (getDeletedposts) can show them and revertDeletePost can restore them.
    await PostFiles.updateMany(
      { postId: ObjectId(postId), status: CURRENT_STATUS.ACTIVE },
      { $set: { status: CURRENT_STATUS.DELETED } },
    );
    await invalidatePostsUploadsCacheByPostId(postId);
    return result;
  };

  public static getPostStatus = (postId: string) => {
    return Posts.findById(postId, { status: 1 });
  };

  public static findById = (postId: string) => {
    return Posts.findById(postId);
  };

  public static getMyTotalPosts = (userId: any) => {
    return Posts.countDocuments({ userId });
  };

  public static put = async ({ postId, update }) => {
    const { files, ...postUpdate } = update || {};
    const postIdObj = ObjectId(postId);

    const [post, currentFiles] = await Promise.all([
      Posts.findByIdAndUpdate(
        postIdObj,
        { $set: postUpdate },
        {
          new: true,
          projection: { companyId: 1, projectId: 1, userId: 1, totalFiles: 1 },
          lean: true,
        },
      ),
      PostFiles.find({
        postId: postIdObj,
        status: CURRENT_STATUS.ACTIVE,
      }).lean(),
    ]);

    if (!post) {
      await invalidatePostsUploadsCacheByPostId(postId);
      return null;
    }

    if (Array.isArray(files)) {
      // Index current files for quick lookup
      const currentById = new Map<string, any>();
      const currentByUrl = new Map<string, any>();
      for (const f of currentFiles) {
        currentById.set(String(f._id), f);
        if (f.url) currentByUrl.set(f.url as string, f);
      }

      const keptIds = new Set<string>();
      const updateOps: any[] = [];
      const insertDocs: any[] = [];
      let orderPos = 0;

      // Categorize each payload entry: update existing OR insert new
      for (const f of files) {
        if (!f) continue;

        const $set: Record<string, any> = {};
        if (Array.isArray(f.tags)) {
          $set.tags = f.tags.map((t: string) => ObjectId(t));
        }
        if (f.note !== undefined) {
          $set.note = f.note ?? "";
        }
        if (f.description !== undefined) {
          $set.description = f.description ?? "";
        }

        // Match against current files by _id, falling back to url
        let matchedId: string | null = null;
        if (f._id && currentById.has(String(f._id))) {
          matchedId = String(f._id);
        } else if (f.url && currentByUrl.has(f.url)) {
          matchedId = String(currentByUrl.get(f.url)._id);
        }

        const desiredPos =
          typeof f.position === "number" ? f.position : orderPos;

        if (matchedId) {
          keptIds.add(matchedId);
          const currentFile = currentById.get(matchedId);
          if (f.url && currentFile && f.url !== currentFile.url) {
            $set.url = f.url;
            if (f.fileType !== undefined) $set.fileType = f.fileType;
            if (f.size !== undefined) $set.size = f.size;
            if (f.thumbnail !== undefined) $set.thumbnail = f.thumbnail;
            if (f.quickView !== undefined) $set.quickView = f.quickView;
            // The url changing in place IS the edit-replace: remember the file
            // it had before so it can be reverted. Set-once — a second edit
            // must not make the first edit the "original".
            if (!currentFile.originalFileUrl) {
              $set.originalFileUrl = currentFile.url;
            }
          }
          // Non-destructive edit data round-trips on any matched file so a
          // saved edit can be reopened; undefined leaves the stored value be.
          if (f.editDocument !== undefined) {
            $set.editDocument = f.editDocument;
          }
          if (f.originalUri !== undefined) {
            $set.originalUri = f.originalUri;
          }
          if (f.annotated_by !== undefined) {
            $set.annotated_by = f.annotated_by;
          }
          if (currentFile && currentFile.position !== desiredPos) {
            $set.position = desiredPos;
          }
          if (Object.keys($set).length) {
            updateOps.push({
              updateOne: {
                filter: { _id: ObjectId(matchedId), postId: postIdObj },
                update: { $set },
              },
            });
          }
        } else if (f.url) {
          // New file — insert at its payload-order position
          insertDocs.push({
            postId: postIdObj,
            companyId: (post as any).companyId,
            projectId: (post as any).projectId,
            userId: (post as any).userId,
            position: desiredPos,
            status: CURRENT_STATUS.ACTIVE,
            url: f.url,
            ...(f.fileType !== undefined && { fileType: f.fileType }),
            ...(f.size !== undefined && { size: f.size }),
            ...(f.timestamp !== undefined && { timestamp: f.timestamp }),
            ...(f.uploadedAt !== undefined && { uploadedAt: f.uploadedAt }),
            ...(f.quickView !== undefined && { quickView: f.quickView }),
            ...(f.thumbnail !== undefined && { thumbnail: f.thumbnail }),
            ...(f.location !== undefined && { location: f.location }),
            ...(f.annotated_by !== undefined && {
              annotated_by: f.annotated_by,
            }),
            ...(f.hash !== undefined && { hash: f.hash }),
            ...(Array.isArray(f.tags) && {
              tags: f.tags.map((t: string) => ObjectId(t)),
            }),
            ...(f.note !== undefined && { note: f.note ?? "" }),
            ...(f.description !== undefined && {
              description: f.description ?? "",
            }),
            ...(f.editDocument !== undefined && {
              editDocument: f.editDocument,
            }),
            ...(f.originalUri !== undefined && { originalUri: f.originalUri }),
            // A NEW file carries its own pre-edit image (uploaded alongside it
            // by the create/upload pipeline), so it is safe to trust here —
            // unlike the matched branch, where the revert target is derived
            // server-side from the url being replaced, never from the payload.
            ...(f.originalFileUrl !== undefined && {
              originalFileUrl: f.originalFileUrl,
            }),
          });
        }
        orderPos = Math.max(orderPos, desiredPos) + 1;
      }

      // Removed = current files NOT referenced by the payload
      const removed = currentFiles.filter(
        (f: any) => !keptIds.has(String(f._id)),
      );

      const deletedDocs = removed.map((f: any) => {
        const {
          _id,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          postId: _pid,
          projectId: pId,
          userId: uId,
          ...fileData
        } = f;
        return {
          postId: postIdObj,
          projectId: pId,
          userId: uId,
          fileId: _id,
          fileData,
          status: CURRENT_STATUS.DELETED,
          deletedAt: new Date(),
        };
      });

      // All file mutations run in parallel
      await Promise.all([
        updateOps.length
          ? PostFiles.bulkWrite(updateOps as any)
          : Promise.resolve(),
        insertDocs.length
          ? PostFiles.insertMany(insertDocs)
          : Promise.resolve(),
        deletedDocs.length
          ? DeletedPostFiles.insertMany(deletedDocs)
          : Promise.resolve(),
        removed.length
          ? PostFiles.deleteMany({
              _id: { $in: removed.map((f: any) => f._id) },
            })
          : Promise.resolve(),
      ]);

      // Adjust totalFiles by net change
      const netChange = insertDocs.length - removed.length;
      if (netChange !== 0) {
        await Posts.findByIdAndUpdate(postIdObj, {
          $inc: { totalFiles: netChange },
        });
      }
    }

    const oldProjectId = currentFiles[0]?.projectId
      ? String(currentFiles[0].projectId)
      : null;
    const oldCompanyId = currentFiles[0]?.companyId
      ? String(currentFiles[0].companyId)
      : null;
    const fileLevelSet: Record<string, any> = {};
    if (postUpdate.projectId && String(postUpdate.projectId) !== oldProjectId) {
      fileLevelSet.projectId = ObjectId(String(postUpdate.projectId));
    }
    if (postUpdate.companyId && String(postUpdate.companyId) !== oldCompanyId) {
      fileLevelSet.companyId = ObjectId(String(postUpdate.companyId));
    }
    if (Object.keys(fileLevelSet).length) {
      await PostFiles.updateMany({ postId: postIdObj }, { $set: fileLevelSet });
    }

    await invalidatePostsUploadsCacheByPostId(postId);

    if (
      fileLevelSet.companyId &&
      oldCompanyId &&
      String(fileLevelSet.companyId) !== oldCompanyId
    ) {
      try {
        await invalidatePostsUploadsCache(oldCompanyId);
      } catch (err) {
        console.error(
          "Cache: Failed to invalidate old company cache after move:",
          err,
        );
      }
    }
    return post;
  };

  public static updateTags = async ({ postId, fileId, tagIds }) => {
    const result = await PostFiles.updateOne(
      { _id: ObjectId(fileId), postId: ObjectId(postId) },
      {
        $set: {
          tags: tagIds.map((id) => ObjectId(id)),
        },
      },
    );
    await invalidatePostsUploadsCacheByPostId(postId);
    return result;
  };

  public static getPostFileById = async ({
    postId,
    fileId,
  }: {
    postId: string;
    fileId: string;
  }) => {
    return PostFiles.findOne({
      _id: ObjectId(fileId),
      postId: ObjectId(postId),
    }).lean();
  };

  public static updateFileDescription = async ({
    postId,
    fileId,
    description,
  }: {
    postId: string;
    fileId: string;
    description: string;
  }) => {
    const result = await PostFiles.updateOne(
      { _id: ObjectId(fileId), postId: ObjectId(postId) },
      { $set: { description: description ?? "" } },
    );
    await invalidatePostsUploadsCacheByPostId(postId);
    return result;
  };

  public static bulkUpdateTags = async (
    pairs: Array<{ postId: string; fileId: string }>,
    tags: string[],
    isAdd: boolean,
  ) => {
    if (!pairs.length || !tags.length) {
      return { modifiedCount: 0 };
    }

    const tagObjectIds = tags.map((id) => ObjectId(id));

    const bulkOps = pairs.map(({ postId, fileId }) => ({
      updateOne: {
        filter: {
          _id: ObjectId(fileId),
          postId: ObjectId(postId),
        },
        update: isAdd
          ? { $addToSet: { tags: { $each: tagObjectIds } } }
          : { $pullAll: { tags: tagObjectIds } },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await PostFiles.bulkWrite(bulkOps as any);
    const uniquePostIds = Array.from(new Set(pairs.map((p) => p.postId)));
    await Promise.all(
      uniquePostIds.map((id) => invalidatePostsUploadsCacheByPostId(id)),
    );
    return { modifiedCount: result.modifiedCount ?? 0 };
  };

  public static getPostProjectId = (postId) => {
    return Posts.findById(postId, { projectId: 1, companyId: 1 });
  };

  // Bumps updatedAt on every distinct project the given posts belong to.
  public static touchPostProjects = async (postIds: string[]) => {
    if (!postIds.length) return;
    const posts = await Posts.find(
      { _id: { $in: postIds.map((id) => ObjectId(id)) } },
      { projectId: 1 },
    );
    const projectIds = Array.from(
      new Set(posts.map((p) => p.projectId.toString())),
    );
    await Promise.all(
      projectIds.map((id) => ProjectHelper.updateProjectInfo(ObjectId(id))),
    );
  };

  public static getprojectPostIds = (projectId) => {
    return Posts.find(
      { projectId, status: CURRENT_STATUS.ACTIVE },
      { _id: 1 },
    ).sort({ createdAt: -1 });
  };

  // File-level match, same fields getGridPosts filters on, so scroll and
  // grid see the same file set
  private static buildScrollFilters = async (
    projectId: ObjectIdType,
    query?: Omit<ProjectScrollQuery, "projectId" | "page" | "limit">,
  ): Promise<{
    fileMatch: Record<string, unknown>;
    isEmpty: boolean;
  }> => {
    const fileMatch: Record<string, unknown> = {
      projectId,
      status: CURRENT_STATUS.ACTIVE,
    };

    // getGridPosts scopes files to the project's company — mirror it
    const project = await ProjectHelper.getCompanyId(String(projectId));
    if (project?.companyId) {
      fileMatch.companyId = project.companyId;
    }

    if (query?.filterUsers) {
      const filteredUsersArray = JSON.parse(query.filterUsers);
      if (filteredUsersArray?.length) {
        fileMatch.userId = {
          $in: filteredUsersArray.map((id: string) => ObjectId(id)),
        };
      }
    } else if (query?.userId && isValidObjectId(query.userId)) {
      fileMatch.userId = ObjectId(query.userId);
    }

    if (query?.dateRange) {
      fileMatch.createdAt = {
        $gte: new Date(query.dateRange.startDate),
        $lte: new Date(query.dateRange.endDate),
      };
    }

    if (query?.filterPostTags) {
      const filterTags = JSON.parse(query.filterPostTags);
      if (filterTags?.length) {
        fileMatch.tags = {
          $in: filterTags.map((tag: string) => ObjectId(tag)),
        };
      }
    }

    let isEmpty = false;
    if (query?.search) {
      const { postIds, fileOr } = await PostsHelper.buildSearchMatch(
        query.search,
        { projectId },
      );
      fileMatch.$and = [{ $or: fileOr }];
      isEmpty = postIds.length === 0;
    }

    return { fileMatch, isEmpty };
  };

  private static buildScrollSort = (
    sortBy?: SORT_TYPE,
  ): {
    preSortStages: PipelineStage[];
    sortSpec: Record<string, 1 | -1>;
  } => {
    const order: 1 | -1 =
      sortBy === SORT_TYPE.OLDEST || sortBy === SORT_TYPE.DATE_TAKEN_ASC
        ? 1
        : -1;
    const sortByTimestamp =
      sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
      sortBy === SORT_TYPE.DATE_TAKEN_DESC;

    return {
      preSortStages: [
        {
          $setWindowFields: {
            partitionBy: "$postId",
            sortBy: { position: 1 as const },
            output: {
              fileRank: { $documentNumber: {} },
              postSortDate: {
                $min: "$createdAt",
                window: {
                  documents: ["unbounded", "unbounded"] as [string, string],
                },
              },
            },
          },
        },
      ],
      sortSpec: sortByTimestamp
        ? { timestamp: order, createdAt: order, _id: order }
        : { postSortDate: order, postId: order, position: 1, _id: 1 },
    };
  };

  public static getPostIndexInProject = async (
    projectId: ObjectIdType,
    postId: string,
    query?: Omit<ProjectScrollQuery, "projectId" | "page" | "limit">,
    sortBy?: SORT_TYPE,
    fileId?: string,
  ): Promise<number> => {
    const { fileMatch, isEmpty } = await PostsHelper.buildScrollFilters(
      projectId,
      query,
    );
    if (isEmpty) return -1;

    const { preSortStages, sortSpec } = PostsHelper.buildScrollSort(sortBy);
    const anchorFileId =
      fileId && isValidObjectId(fileId) ? ObjectId(fileId) : null;

    const [anchor] = await PostFiles.aggregate(
      [
        { $match: fileMatch },
        ...preSortStages,
        { $sort: sortSpec },
        {
          $group: {
            _id: null,
            ids: { $push: "$_id" },
            postIds: { $push: "$postId" },
          },
        },
        {
          $project: {
            fileRank: { $indexOfArray: ["$ids", anchorFileId] },
            postRank: { $indexOfArray: ["$postIds", ObjectId(postId)] },
          },
        },
      ],
      { allowDiskUse: true },
    );
    if (!anchor) return -1;
    return anchor.fileRank >= 0 ? anchor.fileRank : anchor.postRank;
  };

  public static getprojectPosts = async (
    query: ProjectScrollQuery,
    sortBy?: SORT_TYPE,
  ) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skips = (page - 1) * limit;

    const userDetailsLookUp = getOnlyBasicUserDetails();
    const projectNamePipeline = getProjectNamePipeline();
    const postNoteLookUp = getPostNote();

    const { fileMatch, isEmpty } = await PostsHelper.buildScrollFilters(
      query.projectId,
      query,
    );
    if (isEmpty) {
      return { items: [], total: 0, page, pageSize: limit, totalPages: 0 };
    }

    const { preSortStages, sortSpec } = PostsHelper.buildScrollSort(sortBy);

    const [total, items] = await Promise.all([
      PostFiles.countDocuments(fileMatch),
      PostFiles.aggregate(
        [
          { $match: fileMatch },
          ...preSortStages,
          { $sort: sortSpec },
          { $skip: skips },
          { $limit: limit },
          ...userDetailsLookUp,
          ...projectNamePipeline,
          ...postNoteLookUp,
          {
            $project: {
              _id: "$postId",
              companyId: 1,
              note: { $arrayElemAt: ["$postInfo.note", 0] },
              createdAt: { $arrayElemAt: ["$postInfo.createdAt", 0] },
              profileImage: 1,
              userName: 1,
              projectName: 1,
              projectId: 1,
              userId: 1,
              totalFiles: { $arrayElemAt: ["$postInfo.totalFiles", 0] },
              fileIndex: { $subtract: ["$fileRank", 1] },
              file: filesObject,
            },
          },
        ],
        { allowDiskUse: true },
      ),
    ]);

    items.forEach((item, index) => {
      item.postIndex = skips + index;
    });

    return {
      items,
      total,
      page,
      pageSize: limit,
      totalPages: Math.ceil(total / limit),
    };
  };

  // Predicate matching all files that sort STRICTLY BEFORE the anchor under
  // `keys` ([field, direction] in sort order): one $or branch per prefix
  // length — equality on the prefix, strict inequality on the next key. Each
  // branch is a contiguous range on the matching uploads_v2 index, so
  // counting them is an index-only scan. Keys the anchor is missing (legacy
  // docs without `timestamp`) end the expansion — the rank degrades toward 0
  // instead of erroring.
  private static buildBeforeAnchorPredicate = (
    keys: Array<[string, 1 | -1]>,
    anchor: Record<string, unknown>,
  ): Record<string, unknown>[] => {
    const or: Record<string, unknown>[] = [];
    for (let i = 0; i < keys.length; i++) {
      const clause: Record<string, unknown> = {};
      let usable = true;
      for (let j = 0; j < i; j++) {
        const [field] = keys[j];
        if (anchor[field] === undefined) {
          usable = false;
          break;
        }
        clause[field] = anchor[field];
      }
      const [field, dir] = keys[i];
      if (!usable || anchor[field] === undefined) break;
      clause[field] =
        dir === 1 ? { $lt: anchor[field] } : { $gt: anchor[field] };
      or.push(clause);
    }
    return or;
  };

  private static scrollSortKeysV2 = (
    sortBy?: SORT_TYPE,
  ): Array<[string, 1 | -1]> => {
    const order: 1 | -1 =
      sortBy === SORT_TYPE.OLDEST || sortBy === SORT_TYPE.DATE_TAKEN_ASC
        ? 1
        : -1;
    const sortByTimestamp =
      sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
      sortBy === SORT_TYPE.DATE_TAKEN_DESC;
    return sortByTimestamp
      ? [
          ["timestamp", order],
          ["createdAt", order],
          ["_id", order],
        ]
      : [
          ["postSortDate", order],
          ["postId", order],
          ["position", 1],
          ["_id", 1],
        ];
  };

  // V2 of getPostIndexInProject: rank of the anchor file/post in the sorted
  // project feed as COUNT(files sorting before the anchor) — an index-range
  // count — instead of window-sorting the whole project and $indexOfArray
  // over an in-memory array of every file id. Requires postSortDate
  // (uploads-v2 backfill) and the uploads_v2 indexes.
  public static getPostIndexInProjectV2 = async (
    projectId: ObjectIdType,
    postId: string,
    query?: Omit<ProjectScrollQuery, "projectId" | "page" | "limit">,
    sortBy?: SORT_TYPE,
    fileId?: string,
  ): Promise<number> => {
    const { fileMatch, isEmpty } = await PostsHelper.buildScrollFilters(
      projectId,
      query,
    );
    if (isEmpty) return -1;

    // Note-search narrows to specific postIds; an anchor outside that set is
    // "not in the feed" (v1 returned -1 via $indexOfArray misses).
    const searchPostIds = (
      fileMatch.postId as { $in?: ObjectIdType[] } | undefined
    )?.$in;
    if (
      searchPostIds &&
      !searchPostIds.some((id) => String(id) === String(postId))
    ) {
      return -1;
    }

    const sortKeys = PostsHelper.scrollSortKeysV2(sortBy);
    const sortSpec = Object.fromEntries(sortKeys) as Record<string, 1 | -1>;
    const projection = sortKeys.reduce(
      (acc, [field]) => ({ ...acc, [field]: 1 }),
      {} as Record<string, number>,
    );

    // Anchor doc: the exact file when given, else the anchor post's first
    // file in feed order (mirrors v1's first-occurrence $indexOfArray).
    const anchorFileId =
      fileId && isValidObjectId(fileId) ? ObjectId(fileId) : null;
    let anchor = anchorFileId
      ? await PostFiles.findOne(
          { ...fileMatch, _id: anchorFileId },
          projection,
        ).lean<Record<string, unknown>>()
      : null;
    if (!anchor) {
      anchor = await PostFiles.findOne(
        { ...fileMatch, postId: ObjectId(postId) },
        projection,
      )
        .sort(sortSpec)
        .lean<Record<string, unknown>>();
    }
    if (!anchor) return -1;

    const before = PostsHelper.buildBeforeAnchorPredicate(sortKeys, anchor);
    if (!before.length) return 0;
    return PostFiles.countDocuments({ ...fileMatch, $or: before });
  };

  // V2 of getprojectPosts: identical contract, but pages via an indexed walk
  // (persisted postSortDate / timestamp) with enrichment bounded to the
  // page's posts — same pattern as getGridPostsV2. Count comes from the
  // shared uploads count cache.
  public static getprojectPostsV2 = async (
    query: ProjectScrollQuery,
    sortBy?: SORT_TYPE,
  ) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skips = (page - 1) * limit;

    const { fileMatch, isEmpty } = await PostsHelper.buildScrollFilters(
      query.projectId,
      query,
    );
    if (isEmpty) {
      return { items: [], total: 0, page, pageSize: limit, totalPages: 0 };
    }

    const sortKeys = PostsHelper.scrollSortKeysV2(sortBy);
    const pageSort = Object.fromEntries(sortKeys) as Record<string, 1 | -1>;

    const [total, pageFiles] = await Promise.all([
      getCachedUploadsTotal(
        fileMatch.companyId ? String(fileMatch.companyId) : undefined,
        fileMatch,
        () => PostFiles.countDocuments(fileMatch),
      ),
      PostFiles.find(fileMatch, { _id: 1, postId: 1 })
        .sort(pageSort)
        .skip(skips)
        .limit(limit)
        .lean<{ _id: ObjectIdType; postId?: ObjectIdType }[]>(),
    ]);

    const seenPostIds: Record<string, boolean> = {};
    const pagePostIds: Types.ObjectId[] = [];
    for (const f of pageFiles) {
      const pid = f.postId?.toString();
      if (pid && !seenPostIds[pid]) {
        seenPostIds[pid] = true;
        pagePostIds.push(ObjectId(pid));
      }
    }

    const userDetailsLookUp = getOnlyBasicUserDetails();
    const projectNamePipeline = getProjectNamePipeline();
    const postNoteLookUp = getPostNote();

    const enriched = pagePostIds.length
      ? await PostFiles.aggregate([
          { $match: { ...fileMatch, postId: { $in: pagePostIds } } },
          // Bounded to the page's posts — fileRank costs O(page), not
          // O(project).
          {
            $setWindowFields: {
              partitionBy: "$postId",
              sortBy: { position: 1 as const },
              output: { fileRank: { $documentNumber: {} } },
            },
          },
          ...userDetailsLookUp,
          ...projectNamePipeline,
          ...postNoteLookUp,
          {
            $project: {
              _id: "$postId",
              companyId: 1,
              note: { $arrayElemAt: ["$postInfo.note", 0] },
              createdAt: { $arrayElemAt: ["$postInfo.createdAt", 0] },
              profileImage: 1,
              userName: 1,
              projectName: 1,
              projectId: 1,
              userId: 1,
              totalFiles: { $arrayElemAt: ["$postInfo.totalFiles", 0] },
              fileIndex: { $subtract: ["$fileRank", 1] },
              file: filesObject,
            },
          },
        ])
      : [];

    // Restore the page order the enrichment lost.
    const byFileId: Record<string, { postIndex?: number }> = {};
    for (const item of enriched as Array<{
      file?: { _id?: unknown };
      postIndex?: number;
    }>) {
      const fid = item?.file?._id;
      if (fid) byFileId[String(fid)] = item;
    }
    const items = pageFiles.map((f) => byFileId[String(f._id)]).filter(Boolean);
    items.forEach((item, index) => {
      item.postIndex = skips + index;
    });

    return {
      items,
      total,
      page,
      pageSize: limit,
      totalPages: Math.ceil(total / limit),
    };
  };

  // Tab badge count for Uploads. Mirrors the Uploads grid total computed in
  // getGridPosts / findAll (both count ACTIVE PostFiles by project), so the
  // badge matches exactly what the Uploads tab shows.
  public static getProjectPhotoCount = (projectId: string) => {
    return PostFiles.countDocuments({
      projectId: ObjectId(projectId),
      status: CURRENT_STATUS.ACTIVE,
    });
  };

  public static getPostFilesCount = (projectId) => {
    return PostFiles.aggregate([
      {
        $match: {
          projectId,
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      },
      postFilesLookupStage,
      {
        $project: {
          files: "$files._id",
        },
      },
    ]);
  };

  public static deleteFile = async (postId: mongoId, fileId: mongoId) => {
    const fileDoc = await PostFiles.findOne({
      _id: fileId,
      postId,
    }).lean();

    if (!fileDoc) {
      throw new Error("File not found");
    }

    // Strip identifiers that should live on DeletedPostFiles, not fileData.
    const {
      _id,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      postId: _postId,
      projectId: filesProjectId,
      userId: filesUserId,
      ...fileData
    } = fileDoc as Record<string, unknown>;

    await Promise.all([
      DeletedPostFiles.create({
        postId,
        projectId: filesProjectId,
        userId: filesUserId,
        fileId: _id,
        fileData,
        status: CURRENT_STATUS.DELETED,
        deletedAt: new Date(),
      }),
      PostFiles.deleteOne({ _id: fileId, postId }),

      // Decrement totalFiles count
      Posts.findByIdAndUpdate(postId, { $inc: { totalFiles: -1 } }),
    ]);

    // Bust the company's cached uploads so the deleted file stops showing.
    await invalidatePostsUploadsCacheByPostId(postId);

    return;
  };

  public static deleteMultipleFiles = async (
    files: Array<{ postId: string; fileIds: string[] }>,
  ) => {
    const postsToDelete: string[] = [];
    const filesToMoveToTrash: DeletedPostFileDocument[] = [];
    const fileIdsToRemove: Types.ObjectId[] = [];
    const postFileCountUpdates: { postId: string; count: number }[] = [];

    for (const item of files) {
      const [post, postFiles] = await Promise.all([
        Posts.findById(item.postId, {
          projectId: 1,
          userId: 1,
        }),
        PostFiles.find({ postId: ObjectId(item.postId) }).lean(),
      ]);

      if (!post) continue;

      const fileIdsToDelete = item.fileIds.map((id) => id.toString());
      const allFileIds = postFiles.map((file) => file._id.toString());

      const isAllFilesDeleted = allFileIds.every((id) =>
        fileIdsToDelete.includes(id),
      );

      const filesToDelete = postFiles.filter((file) =>
        fileIdsToDelete.includes(file._id.toString()),
      );

      if (filesToDelete.length === 0) continue;

      for (const fileDoc of filesToDelete) {
        const {
          _id,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          postId: _postId,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          projectId: _filesProjectId,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          userId: _filesUserId,
          ...fileData
        } = fileDoc as Record<string, unknown>;

        filesToMoveToTrash.push({
          postId: ObjectId(item.postId) as ObjectIdType,
          projectId: post.projectId as ObjectIdType,
          userId: post.userId as ObjectIdType,
          fileId: _id as ObjectIdType,
          fileData: fileData,
          status: CURRENT_STATUS.DELETED,
          deletedAt: new Date(),
        });

        fileIdsToRemove.push(_id as Types.ObjectId);
      }

      if (isAllFilesDeleted) {
        // Whole post emptied: soft-delete the parent post too.
        postsToDelete.push(item.postId);
      } else {
        // Partial deletion: decrement the post's totalFiles count.
        postFileCountUpdates.push({
          postId: item.postId,
          count: filesToDelete.length,
        });
      }
    }

    if (filesToMoveToTrash.length > 0) {
      await DeletedPostFiles.insertMany(filesToMoveToTrash);
    }

    if (postsToDelete.length > 0) {
      await Posts.updateMany(
        { _id: { $in: postsToDelete.map((id) => ObjectId(id)) } },
        { $set: { status: CURRENT_STATUS.DELETED } },
      );
    }

    if (fileIdsToRemove.length > 0) {
      await PostFiles.deleteMany({ _id: { $in: fileIdsToRemove } });
    }

    // Update totalFiles count for posts where only some files were deleted
    if (postFileCountUpdates.length > 0) {
      const bulkOps = postFileCountUpdates.map((update) => ({
        updateOne: {
          filter: { _id: ObjectId(update.postId) },
          update: { $inc: { totalFiles: -update.count } },
        },
      }));
      await Posts.bulkWrite(bulkOps);
    }

    if (files.length > 0) {
      await invalidatePostsUploadsCacheByPostId(files[0].postId);
    }

    return {
      postsDeleted: postsToDelete.length,
      filesDeleted: filesToMoveToTrash.length,
    };
  };

  public static deleteUnfinalizedFiles = async (
    files: Array<{ postId: string; fileIds: string[] }>,
  ) => {
    let filesDeleted = 0;
    for (const item of files) {
      const fileObjectIds = item.fileIds.map((id) => ObjectId(id));
      const postFiles = (await PostFiles.find(
        { _id: { $in: fileObjectIds }, postId: ObjectId(item.postId) },
        { url: 1, originalFileUrl: 1 },
      ).lean()) as Array<{ url?: string; originalFileUrl?: string }>;
      if (postFiles.length === 0) continue;

      // Includes the retained pre-edit original (the revert target) so a hard
      // delete doesn't leave it orphaned in S3.
      const urls = postFiles
        .flatMap((f) => [f.url, f.originalFileUrl])
        .filter((u): u is string => !!u);

      await Promise.all(urls.map((u) => fileService.deleteFromS3UsingLink(u)));
      await Promise.all([
        PostFiles.deleteMany({
          _id: { $in: fileObjectIds },
          postId: ObjectId(item.postId),
        }),
        Posts.findByIdAndUpdate(ObjectId(item.postId), {
          $inc: { totalFiles: -postFiles.length },
        }),
      ]);
      filesDeleted += postFiles.length;
      await invalidatePostsUploadsCacheByPostId(item.postId);
    }
    return { filesDeleted };
  };

  public static getPostInfo = (postId: mongoId) => {
    return Posts.findById(postId);
  };

  private static attachGridProjectNames = async (
    items: UploadsGridRow[],
    companyId: ObjectIdType,
  ): Promise<UploadsGridRow[]> => {
    const projectIds = Array.from(
      new Set(
        items.flatMap((item) => (item.projectId ? [String(item.projectId)] : [])),
      ),
    );
    if (!projectIds.length) return items;

    // Resolve only the returned page, not all sibling files hydrated for ranking.
    const projects = await Project.find(
      { _id: { $in: projectIds }, companyId },
      { _id: 1, name: 1 },
    ).lean<UploadsProjectName[]>();
    const names = new Map(
      projects.map((project) => [String(project._id), project.name?.trim()]),
    );

    return items.map((item) => {
      const projectName = names.get(String(item.projectId));
      return projectName ? { ...item, projectName } : item;
    });
  };

  public static getGridPosts = async (
    query: PaginatedSearchQuery & MyUploadsQuery,
    user?: UploadsScopeUser,
  ) => {
    const {
      page,
      skips,
      pageSize,
      projectId,
      userId,
      filterUsers,
      filterProjects,
      filterPostTags,
    } = query;

    const userDetailsLookUp = getOnlyBasicUserDetails();
    const getPostNoteLookUp = getPostNote();

    let scopedCompanyId: ObjectIdType | undefined = user?.companyIds?.[0];
    if (projectId) {
      const project = await ProjectHelper.getCompanyId(projectId);
      if (project?.companyId) {
        scopedCompanyId = project.companyId as ObjectIdType;
      }
    }

    if (!scopedCompanyId) {
      throw new Error("Missing required fields for fetching posts.");
    }
    // File-level match — every field below is already present on postfiles.
    const matchQuery: any = {
      status: CURRENT_STATUS.ACTIVE,
    };

    if (scopedCompanyId) {
      matchQuery.companyId = scopedCompanyId;
    }

    if (filterProjects) {
      const filteredProjectsArray = JSON.parse(filterProjects);
      if (filteredProjectsArray?.length) {
        matchQuery.projectId = {
          $in: filteredProjectsArray.map((id: string) => ObjectId(id)),
        };
      }
    } else if (projectId) {
      matchQuery.projectId = ObjectId(projectId);
    } else if (user?.role && !isAdminUser(user?.role)) {
      const { projectIds } = await ProjectHelper.getMineAndCompanyProjects(
        user?.companyIds ?? [],
        user?.userId,
      );
      matchQuery.projectId = { $in: projectIds };
    }

    if (query?.dateRange) {
      matchQuery.createdAt = {
        $gte: new Date(query.dateRange.startDate),
        $lte: new Date(query.dateRange.endDate),
      };
    }

    if (filterUsers) {
      const filteredUsersArray = JSON.parse(filterUsers);
      if (filteredUsersArray?.length) {
        matchQuery.userId = {
          $in: filteredUsersArray.map((id: string) => ObjectId(id)),
        };
      }
    } else if (userId) {
      matchQuery.userId = ObjectId(userId);
    }

    // Note regex lives on Post.note, not postfile. Pre-resolve postIds.
    if (query.postId) {
      const { postIds, fileOr } = await PostsHelper.buildSearchMatch(
        query.postId,
        matchQuery,
      );
      if (postIds.length === 0) {
        return [
          { items: [], total: 0, totalFiles: 0, page, pageSize, totalPages: 0 },
        ];
      }
      matchQuery.$or = fileOr;
    }

    if (filterPostTags) {
      const filterTags = JSON.parse(filterPostTags);
      if (filterTags.length) {
        matchQuery.tags = {
          $in: filterTags.map((tag: string) => ObjectId(tag)),
        };
      }
    }

    const createdOrder: 1 | -1 =
      query?.sortBy === SORT_TYPE.OLDEST ||
      query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC
        ? 1
        : -1;

    const sortByTimestamp =
      query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
      query?.sortBy === SORT_TYPE.DATE_TAKEN_DESC;

    const sortSpec: Record<string, 1 | -1> = sortByTimestamp
      ? {
          sortTimestamp: createdOrder,
          createdAt: createdOrder,
          _id: createdOrder,
        }
      : {
          postSortDate: createdOrder,
          postId: createdOrder,
          position: 1,
          _id: 1,
        };
    const sortStage = { $sort: sortSpec };
    const timestampFallbackStage = sortByTimestamp
      ? [
          {
            $addFields: {
              sortTimestamp: { $ifNull: ["$timestamp", "$createdAt"] },
            },
          },
        ]
      : [];

    const contiguousIndexStage = [
      {
        $setWindowFields: {
          partitionBy: "$postId",
          sortBy: { position: 1 as const },
          output: {
            fileRank: { $documentNumber: {} },
            postSortDate: {
              $min: "$createdAt",
              window: {
                documents: ["unbounded", "unbounded"] as [string, string],
              },
            },
          },
        },
      },
    ];
    const contiguousIndex = { $subtract: ["$fileRank", 1] };

    if (sortByTimestamp) {
      const [total, pageFiles] = await Promise.all([
        PostFiles.countDocuments(matchQuery),
        PostFiles.find(matchQuery, { _id: 1, postId: 1 })
          .sort({
            timestamp: createdOrder,
            createdAt: createdOrder,
            _id: createdOrder,
          })
          .skip(skips)
          .limit(pageSize)
          .lean(),
      ]);

      const seenPostIds: Record<string, boolean> = {};
      const pagePostIds: any[] = [];
      for (const f of pageFiles as any[]) {
        const pid = f.postId?.toString();
        if (pid && !seenPostIds[pid]) {
          seenPostIds[pid] = true;
          pagePostIds.push(ObjectId(pid));
        }
      }

      const enriched = pagePostIds.length
        ? await PostFiles.aggregate<UploadsGridRow>(
            [
              { $match: { ...matchQuery, postId: { $in: pagePostIds } } },
              ...contiguousIndexStage,
              ...userDetailsLookUp,
              ...getPostNoteLookUp,
              {
                $project: {
                  _id: "$postId",
                  profileImage: 1,
                  userName: 1,
                  createdAt: "$createdAt",
                  userId: 1,
                  projectId: 1,
                  note: { $arrayElemAt: ["$postInfo.note", 0] },
                  noteCount: "$commentCount",
                  files: filesObject,
                  fileIndex: contiguousIndex,
                },
              },
            ],
            { allowDiskUse: true },
          )
        : [];

      const byFileId: Record<string, UploadsGridRow> = {};
      for (const item of enriched) {
        const fid = item?.files?._id;
        if (fid) byFileId[String(fid)] = item;
      }
      const items = (pageFiles as any[])
        .map((f) => byFileId[String(f._id)])
        .filter(Boolean);

      return [
        {
          items: await this.attachGridProjectNames(items, scopedCompanyId),
          total,
          // Grid mode paginates by file, so `total` is already a file count.
          totalFiles: total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        },
      ];
    }

    const [totalFiles, items] = await Promise.all([
      PostFiles.countDocuments(matchQuery),
      PostFiles.aggregate<UploadsGridRow>(
        [
          { $match: matchQuery },
          ...contiguousIndexStage,
          ...timestampFallbackStage,
          sortStage,
          { $skip: skips },
          { $limit: pageSize },
          ...userDetailsLookUp,

          // totalFiles per post — only needed when not sorting by timestamp
          // (matches the old endpoint's `sortByTimestamp ? {} : { fileIndex, totalFiles }`).
          ...getPostNoteLookUp,
          // Pack file fields under `files` so the route handler's
          // `item.files.timestamp` access works unchanged.
          {
            $project: {
              _id: "$postId",
              profileImage: 1,
              userName: 1,
              // Non-timestamp: report the post's anchor date so the route's
              // date-grouping keeps a post's files in one group. Timestamp:
              // keep the file's own createdAt (files are date-sorted globally).
              createdAt: sortByTimestamp ? "$createdAt" : "$postSortDate",
              userId: 1,
              projectId: 1,
              note: { $arrayElemAt: ["$postInfo.note", 0] },
              noteCount: "$commentCount",
              // Override the file's sparse `position` with the contiguous
              // index so consumers reading `files.position` see 0..n-1 too.
              files: sortByTimestamp
                ? filesObject
                : { ...filesObject, position: contiguousIndex },
              fileIndex: contiguousIndex,
              ...(sortByTimestamp
                ? {}
                : {
                    totalFiles: { $arrayElemAt: ["$postInfo.totalFiles", 0] },
                  }),
            },
          },
        ],
        { allowDiskUse: true },
      ),
    ]);

    return [
      {
        items: await this.attachGridProjectNames(items, scopedCompanyId),
        total: totalFiles,
        totalFiles,
        page,
        pageSize,
        totalPages: Math.ceil(totalFiles / pageSize),
      },
    ];
  };

  // V2 grid feed (GET /api/posts/uploads/v2): same contract and response
  // shape as getGridPosts, but pages via the persisted postSortDate anchor
  // walked on a compound index instead of $setWindowFields-sorting every
  // matched file per request. Enrichment (fileIndex, lookups, per-post min
  // date) runs only over the page's posts, so cost is bounded by pageSize
  // regardless of collection size. The count comes from a short-TTL Redis
  // cache. Timestamp sorts already page via a bounded find in v1 — they
  // delegate unchanged. Requires scripts/backfillPostSortDate.js (backfill
  // + compound indexes) before this path returns correct order.
  public static getGridPostsV2 = async (
    query: PaginatedSearchQuery & MyUploadsQuery,
    user?: UploadsScopeUser,
  ) => {
    const sortByTimestamp =
      query?.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
      query?.sortBy === SORT_TYPE.DATE_TAKEN_DESC;
    if (sortByTimestamp) {
      return this.getGridPosts(query, user);
    }

    const {
      page,
      skips,
      pageSize,
      projectId,
      userId,
      filterUsers,
      filterProjects,
      filterPostTags,
    } = query;

    let scopedCompanyId: ObjectIdType | undefined = user?.companyIds?.[0];
    if (projectId) {
      const project = await ProjectHelper.getCompanyId(projectId);
      if (project?.companyId) {
        scopedCompanyId = project.companyId as ObjectIdType;
      }
    }
    if (!scopedCompanyId) {
      throw new Error("Missing required fields for fetching posts.");
    }

    // Same file-level match getGridPosts builds — duplicated on purpose so
    // the v1 path stays untouched while v2 is validated.
    const matchQuery: Record<string, unknown> = {
      status: CURRENT_STATUS.ACTIVE,
      companyId: scopedCompanyId,
    };

    if (filterProjects) {
      const filteredProjectsArray = JSON.parse(filterProjects);
      if (filteredProjectsArray?.length) {
        matchQuery.projectId = {
          $in: filteredProjectsArray.map((id: string) => ObjectId(id)),
        };
      }
    } else if (projectId) {
      matchQuery.projectId = ObjectId(projectId);
    } else if (user?.role && !isAdminUser(user?.role)) {
      const { projectIds } = await getProjectScopeMemoized(
        user?.companyIds ?? [],
        user?.userId,
      );
      // Sorted so the count-cache key (a hash of matchQuery) stays stable
      // across requests regardless of membership-query ordering.
      matchQuery.projectId = {
        $in: [...projectIds].sort((a, b) => String(a).localeCompare(String(b))),
      };
    }

    if (query?.dateRange) {
      matchQuery.createdAt = {
        $gte: new Date(query.dateRange.startDate),
        $lte: new Date(query.dateRange.endDate),
      };
    }

    if (filterUsers) {
      const filteredUsersArray = JSON.parse(filterUsers);
      if (filteredUsersArray?.length) {
        matchQuery.userId = {
          $in: filteredUsersArray.map((id: string) => ObjectId(id)),
        };
      }
    } else if (userId) {
      matchQuery.userId = ObjectId(userId);
    }

    if (query.postId) {
      const { postIds, fileOr } = await PostsHelper.buildSearchMatch(
        query.postId,
        matchQuery,
      );
      if (postIds.length === 0) {
        return [
          { items: [], total: 0, totalFiles: 0, page, pageSize, totalPages: 0 },
        ];
      }
      matchQuery.$or = fileOr;
    }

    if (filterPostTags) {
      const filterTags = JSON.parse(filterPostTags);
      if (filterTags.length) {
        matchQuery.tags = {
          $in: filterTags.map((tag: string) => ObjectId(tag)),
        };
      }
    }

    const createdOrder: 1 | -1 = query?.sortBy === SORT_TYPE.OLDEST ? 1 : -1;
    const pageSort: Record<string, 1 | -1> = {
      postSortDate: createdOrder,
      postId: createdOrder,
      position: 1,
      _id: 1,
    };

    const [total, pageFiles] = await Promise.all([
      getCachedUploadsTotal(scopedCompanyId.toString(), matchQuery, () =>
        PostFiles.countDocuments(matchQuery),
      ),
      PostFiles.find(matchQuery, { _id: 1, postId: 1 })
        .sort(pageSort)
        .skip(skips)
        .limit(pageSize)
        .lean<{ _id: ObjectIdType; postId?: ObjectIdType }[]>(),
    ]);

    const seenPostIds: Record<string, boolean> = {};
    const pagePostIds: Types.ObjectId[] = [];
    for (const f of pageFiles) {
      const pid = f.postId?.toString();
      if (pid && !seenPostIds[pid]) {
        seenPostIds[pid] = true;
        pagePostIds.push(ObjectId(pid));
      }
    }

    const userDetailsLookUp = getOnlyBasicUserDetails();
    const getPostNoteLookUp = getPostNote();
    const contiguousIndex = { $subtract: ["$fileRank", 1] };

    const enriched = pagePostIds.length
      ? await PostFiles.aggregate<UploadsGridRow>([
          { $match: { ...matchQuery, postId: { $in: pagePostIds } } },
          // Bounded to the page's posts, so the window function costs
          // O(files per page's posts) instead of O(all matched files).
          // The computed postSortDate (min createdAt over ACTIVE matched
          // files) intentionally shadows the persisted field: display
          // parity with v1 stays exact even if the two ever drift.
          {
            $setWindowFields: {
              partitionBy: "$postId",
              sortBy: { position: 1 as const },
              output: {
                fileRank: { $documentNumber: {} },
                postSortDate: {
                  $min: "$createdAt",
                  window: {
                    documents: ["unbounded", "unbounded"] as [string, string],
                  },
                },
              },
            },
          },
          ...userDetailsLookUp,
          ...getPostNoteLookUp,
          {
            $project: {
              _id: "$postId",
              profileImage: 1,
              userName: 1,
              createdAt: "$postSortDate",
              userId: 1,
              projectId: 1,
              note: { $arrayElemAt: ["$postInfo.note", 0] },
              noteCount: "$commentCount",
              files: { ...filesObject, position: contiguousIndex },
              fileIndex: contiguousIndex,
              totalFiles: { $arrayElemAt: ["$postInfo.totalFiles", 0] },
            },
          },
        ])
      : [];

    // The enrichment loses the page order — restore it from pageFiles.
    const byFileId: Record<string, UploadsGridRow> = {};
    for (const item of enriched) {
      const fid = item?.files?._id;
      if (fid) byFileId[String(fid)] = item;
    }
    const items = pageFiles.map((f) => byFileId[String(f._id)]).filter(Boolean);

    return [
      {
        items: await this.attachGridProjectNames(items, scopedCompanyId),
        total,
        // Grid mode paginates by file, so `total` is already a file count.
        totalFiles: total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    ];
  };

  public static getDeletedposts = async (userId: ObjectIdType) => {
    const projectIds = await ProjectHelper.getMyProjects(userId);

    const matchQuery = {
      projectId: { $in: projectIds },
      status: CURRENT_STATUS.DELETED,
      // Posts binned as part of their whole project belong in the projects bin,
      // not here — one project deletion would otherwise flood this list.
      preDeleteStatus: { $exists: false },
    };

    const pipeline = [
      {
        $match: matchQuery,
      },
      // Soft-deleted posts: include their files regardless of file status so
      // the bin view can preserve what existed at deletion time.
      {
        $lookup: {
          from: "postfiles",
          let: { postId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$postId", "$$postId"] } } },
            { $sort: { position: 1 as const, createdAt: 1 as const } },
          ],
          as: "files",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                "name.first": 1,
                "name.last": 1,
                profileImage: 1,
              },
            },
          ],
          as: "userInfo",
        },
      },
      {
        $lookup: {
          from: "projects",
          localField: "projectId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                name: 1,
              },
            },
          ],
          as: "projectInfo",
        },
      },
      {
        $sort: {
          updatedAt: -1 as -1,
          createdAt: -1 as -1,
        },
      },
      {
        $project: {
          userId: 1,
          note: 1,
          files: 1,
          createdAt: 1,
          projectId: 1,
          userName: {
            $concat: [
              { $arrayElemAt: ["$userInfo.name.first", 0] },
              " ",
              { $arrayElemAt: ["$userInfo.name.last", 0] },
            ],
          },
          profileImage: {
            $arrayElemAt: ["$userInfo.profileImage", 0],
          },
          projectName: {
            $arrayElemAt: ["$projectInfo.name", 0],
          },
        },
      },
    ];

    return Posts.aggregate(pipeline);
  };

  public static revertDeletePost = async (postId: string) => {
    const result = await Posts.findByIdAndUpdate(postId, {
      $set: { status: CURRENT_STATUS.ACTIVE },
    });
    // Restore the files that were hidden when the post was soft-deleted.
    await PostFiles.updateMany(
      { postId: ObjectId(postId), status: CURRENT_STATUS.DELETED },
      { $set: { status: CURRENT_STATUS.ACTIVE } },
    );
    await invalidatePostsUploadsCacheByPostId(postId);
    return result;
  };

  public static getDeletedPostFiles = async (userId: ObjectIdType) => {
    const projectIds = await ProjectHelper.getMyProjects(userId);

    const query = {
      userId,
      status: CURRENT_STATUS.DELETED,
      projectId: { $in: projectIds },
    };

    return DeletedPostFiles.aggregate([
      { $match: query },
      // Lookup user info
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                "name.first": 1,
                "name.last": 1,
                profileImage: 1,
              },
            },
          ],
          as: "userInfo",
        },
      },
      // Lookup project info
      {
        $lookup: {
          from: "projects",
          localField: "projectId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                name: 1,
              },
            },
          ],
          as: "projectInfo",
        },
      },
      // Lookup post info
      {
        $lookup: {
          from: "posts",
          localField: "postId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                note: 1,
                createdAt: 1,
              },
            },
          ],
          as: "postInfo",
        },
      },
      { $sort: { deletedAt: -1 } },
      {
        $project: {
          postId: 1,
          projectId: 1,
          deletedAt: 1,
          userId: 1,
          note: { $arrayElemAt: ["$postInfo.note", 0] },
          createdAt: { $arrayElemAt: ["$postInfo.createdAt", 0] },
          // User info
          userName: {
            $concat: [
              { $arrayElemAt: ["$userInfo.name.first", 0] },
              " ",
              { $arrayElemAt: ["$userInfo.name.last", 0] },
            ],
          },
          profileImage: {
            $arrayElemAt: ["$userInfo.profileImage", 0],
          },
          // Project info
          projectName: {
            $arrayElemAt: ["$projectInfo.name", 0],
          },
          // Files array (match getPost format)
          files: [
            {
              $mergeObjects: [
                "$fileData",
                {
                  _id: "$fileId",
                  deletedAt: "$deletedAt",
                },
              ],
            },
          ],
        },
      },
    ]);
  };

  public static restorePostFile = async (deletedFileId: ObjectIdType) => {
    const deletedFile = await DeletedPostFiles.findById(deletedFileId);

    if (!deletedFile) {
      throw new Error("Deleted file not found");
    }

    const post = await Posts.findById(deletedFile.postId, {
      companyId: 1,
    });

    if (!post) {
      throw new Error("Parent post not found");
    }

    const maxPositionDoc = await PostFiles.findOne(
      { postId: deletedFile.postId },
      { position: 1 },
    )
      .sort({ position: -1 })
      .lean();
    const nextPosition = (maxPositionDoc?.position ?? -1) + 1;

    await Promise.all([
      PostFiles.create({
        ...deletedFile.fileData,
        _id: deletedFile.fileId,
        postId: deletedFile.postId,
        projectId: deletedFile.projectId,
        userId: deletedFile.userId,
        companyId: post.companyId,
        position: nextPosition,
        status: CURRENT_STATUS.ACTIVE,
      }),
      DeletedPostFiles.findByIdAndDelete(deletedFileId),
      // Increment totalFiles count when restoring a file
      Posts.findByIdAndUpdate(deletedFile.postId, {
        $inc: { totalFiles: 1 },
      }),
    ]);

    await invalidatePostsUploadsCache(post.companyId);
  };

  public static updateFileUrl = async ({
    postId,
    fileId,
    fileUrl,
    fileType,
    size,
    annotated_by,
    previousFileUrl,
    editDocument,
    originalUri,
  }: IReplaceOriginalFile) => {
    const $set: Record<string, unknown> = {
      url: fileUrl,
      annotated_by,
      size,
      fileType,
    };
    if (editDocument !== undefined) $set.editDocument = editDocument;
    if (originalUri !== undefined) $set.originalUri = originalUri;

    const filter = { _id: ObjectId(fileId), postId: ObjectId(postId) };

    // Stamp the revert target first, matched on "not set yet" so it is set-once
    // even under concurrent edits: a second edit must not overwrite the true
    // original with the first edit's output.
    if (previousFileUrl) {
      await PostFiles.updateOne(
        { ...filter, originalFileUrl: { $exists: false } },
        { $set: { originalFileUrl: previousFileUrl } },
      );
    }

    const result = await PostFiles.updateOne(filter, { $set });
    await invalidatePostsUploadsCacheByPostId(postId);
    return result;
  };

  /**
   * Restores a file to its pre-edit original: swaps `url` back to the stored
   * originalFileUrl, drops the edit state (editDocument / originalUri /
   * annotated_by) and the derived quickView/thumbnail so they regenerate from
   * the restored image. The file keeps its _id, so comments, notes, tags and
   * position survive. Returns the edited url that is now unreferenced (so the
   * caller can delete it from S3), or null when there is nothing to revert.
   */
  public static revertFileToOriginal = async ({
    postId,
    fileId,
  }: IRevertFileToOriginal): Promise<string | null> => {
    const file = (await PostFiles.findOne(
      { _id: ObjectId(fileId), postId: ObjectId(postId) },
      { url: 1, originalFileUrl: 1 },
    ).lean()) as { url?: string; originalFileUrl?: string } | null;

    if (!file?.originalFileUrl || file.originalFileUrl === file.url) {
      return null;
    }

    await PostFiles.updateOne(
      { _id: ObjectId(fileId), postId: ObjectId(postId) },
      {
        $set: { url: file.originalFileUrl },
        $unset: {
          originalFileUrl: "",
          editDocument: "",
          originalUri: "",
          annotated_by: "",
          quickView: "",
          thumbnail: "",
        },
      },
    );
    await invalidatePostsUploadsCacheByPostId(postId);
    return file.url ?? null;
  };

  public static addFileCopy = async (postId: string, newFileData: any) => {
    const post = await Posts.findById(postId, {
      companyId: 1,
      projectId: 1,
      userId: 1,
    });

    if (!post) {
      return false;
    }

    const maxPositionDoc = await PostFiles.findOne(
      { postId: ObjectId(postId) },
      { position: 1 },
    )
      .sort({ position: -1 })
      .lean();
    const nextPosition = (maxPositionDoc?.position ?? -1) + 1;

    await Promise.all([
      PostFiles.create({
        ...newFileData,
        postId: ObjectId(postId),
        companyId: post.companyId,
        projectId: post.projectId,
        userId: post.userId,
        position: nextPosition,
      }),
      // Increment totalFiles count when adding a file copy
      Posts.findByIdAndUpdate(postId, { $inc: { totalFiles: 1 } }),
    ]);

    await invalidatePostsUploadsCache(post.companyId);

    return true;
  };

  public static getProjectNameByPostId = (postId: string) => {
    return Posts.aggregate([
      { $match: { _id: ObjectId(postId) } },
      {
        $lookup: {
          from: "projects",
          localField: "projectId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                name: 1,
              },
            },
          ],
          as: "projectInfo",
        },
      },
      {
        $project: {
          projectName: { $arrayElemAt: ["$projectInfo.name", 0] },
        },
      },
    ]);
  };

  public static insertFileInPost = async (
    postId: string,
    fileData: FileType,
    position: number,
  ) => {
    const post = await Posts.findById(postId, {
      companyId: 1,
      projectId: 1,
      userId: 1,
    });

    if (!post) {
      throw new Error("Post not found");
    }

    // Shift existing files at or after `position` to make room.
    await PostFiles.updateMany(
      { postId: ObjectId(postId), position: { $gte: position } },
      { $inc: { position: 1 } },
    );

    const [result] = await Promise.all([
      PostFiles.create({
        ...fileData,
        postId: ObjectId(postId),
        companyId: post.companyId,
        projectId: post.projectId,
        userId: post.userId,
        position,
      }),
      // Increment totalFiles count when inserting a file
      Posts.findByIdAndUpdate(postId, { $inc: { totalFiles: 1 } }),
    ]);

    await invalidatePostsUploadsCache(post.companyId);

    return result;
  };

  public static insertFilesInPost = async (
    postId: string,
    files: FileType[],
  ) => {
    if (!files?.length) {
      return { insertedCount: 0 };
    }

    const post = await Posts.findById(postId, {
      companyId: 1,
      projectId: 1,
      userId: 1,
    });

    if (!post) {
      throw new Error("Post not found");
    }

    const maxPositionDoc = await PostFiles.findOne(
      { postId: ObjectId(postId) },
      { position: 1 },
    )
      .sort({ position: -1 })
      .lean();
    const startPosition = (maxPositionDoc?.position ?? -1) + 1;

    const docs = files.map((file, idx) => ({
      ...file,
      postId: ObjectId(postId),
      companyId: post.companyId,
      projectId: post.projectId,
      userId: post.userId,
      position: startPosition + idx,
    }));

    const [inserted] = await Promise.all([
      PostFiles.insertMany(docs),
      // Increment totalFiles count by the number of files inserted
      await Posts.findByIdAndUpdate(postId, {
        $inc: { totalFiles: docs?.length || 0 },
      }),
    ]);

    await invalidatePostsUploadsCache(post.companyId);

    return { insertedCount: inserted.length };
  };

  public static moveFilesToProject = async (
    userId: mongoId,
    targetProjectId: string,
    companyId: mongoId,
    files: Array<{ postId: string; fileIds: string[] }>,
    sourceProjectIds: string[],
  ) => {
    if (!files.length) {
      return { movedFiles: 0, postsMoved: 0, newPostId: null };
    }

    const sourcePostIds = Array.from(
      new Set(files.map((f) => ObjectId(f.postId))),
    );

    const allSourceFiles = await PostFiles.find({
      postId: { $in: sourcePostIds },
    }).lean();

    const filesByPost = new Map<string, typeof allSourceFiles>();
    for (const file of allSourceFiles) {
      const key = file.postId.toString();
      const list = filesByPost.get(key) ?? [];
      list.push(file);
      filesByPost.set(key, list);
    }

    const postsToReassign: string[] = [];
    const partialMoveFilesByPost: Array<{
      sourcePostId: string;
      filesToMove: typeof allSourceFiles;
    }> = [];
    const fileIdsToDelete: Types.ObjectId[] = [];

    for (const item of files) {
      const postFiles = filesByPost.get(item.postId) ?? [];
      const fileIdsToMove = new Set(item.fileIds.map((id) => id.toString()));
      const allFileIds = postFiles.map((file) => file._id.toString());
      const isAllFilesMoved =
        allFileIds.length > 0 &&
        allFileIds.every((id) => fileIdsToMove.has(id));

      if (isAllFilesMoved) {
        postsToReassign.push(item.postId);
      } else {
        const filesToMove = postFiles.filter((file) =>
          fileIdsToMove.has(file._id.toString()),
        );
        if (filesToMove.length) {
          partialMoveFilesByPost.push({
            sourcePostId: item.postId,
            filesToMove,
          });
          for (const file of filesToMove) {
            fileIdsToDelete.push(file._id as Types.ObjectId);
          }
        }
      }
    }

    const dbOps: Promise<any>[] = [];

    if (postsToReassign.length > 0) {
      const reassignIds = postsToReassign.map((id) => ObjectId(id));
      dbOps.push(
        Posts.updateMany(
          { _id: { $in: reassignIds } },
          { $set: { projectId: ObjectId(targetProjectId) } },
        ),
      );
      dbOps.push(
        PostFiles.updateMany(
          { postId: { $in: reassignIds } },
          { $set: { projectId: ObjectId(targetProjectId) } },
        ),
      );
    }

    let newPostId: Types.ObjectId | null = null;
    let movedFileCount = 0;

    if (partialMoveFilesByPost.length > 0) {
      // Count total files that will be moved to the new post
      let totalNewFiles = 0;
      for (const group of partialMoveFilesByPost) {
        totalNewFiles += group.filesToMove.length;
      }

      const newPost = await Posts.create({
        userId,
        companyId,
        projectId: targetProjectId,
        totalFiles: totalNewFiles,
      });
      newPostId = newPost._id;

      const newFileDocs: Array<Record<string, unknown>> = [];
      let position = 0;
      for (const group of partialMoveFilesByPost) {
        for (const file of group.filesToMove) {
          // Strip _id so a new identifier is generated, matching prior behavior.
          /* eslint-disable @typescript-eslint/no-unused-vars */
          const {
            _id: _ignoreId,
            postId: _ignorePostId,
            projectId: _ignoreProjectId,
            userId: _ignoreUserId,
            companyId: _ignoreCompanyId,
            position: _ignorePosition,
            ...rest
          } = file as Record<string, unknown>;
          /* eslint-enable @typescript-eslint/no-unused-vars */
          newFileDocs.push({
            ...rest,
            postId: newPost._id,
            companyId,
            projectId: ObjectId(targetProjectId),
            userId,
            position: position++,
          });
        }
      }

      if (newFileDocs.length) {
        await PostFiles.insertMany(newFileDocs);
        movedFileCount = newFileDocs.length;
      }

      if (fileIdsToDelete.length) {
        dbOps.push(PostFiles.deleteMany({ _id: { $in: fileIdsToDelete } }));
      }

      // Update totalFiles count for posts where only some files were moved
      if (partialMoveFilesByPost.length) {
        const bulkOps = partialMoveFilesByPost.map((group) => ({
          updateOne: {
            filter: { _id: ObjectId(group.sourcePostId) },
            update: { $inc: { totalFiles: -group.filesToMove.length } },
          },
        }));
        dbOps.push(Posts.bulkWrite(bulkOps));
      }
    }

    await Promise.all(dbOps);

    await Promise.all([
      ...sourceProjectIds.map((srcProjectId) =>
        ProjectHelper.updateProjectInfo(ObjectId(srcProjectId)),
      ),
      ProjectHelper.updateProjectInfo(ObjectId(targetProjectId)),
    ]);

    await invalidatePostsUploadsCache(companyId);

    return {
      movedFiles: movedFileCount,
      postsMoved: postsToReassign.length,
      newPostId,
    };
  };

  public static getProjectsPostCount = async (
    companyId: mongoId,
    projectId: mongoId,
  ) => {
    const postCount = await Posts.countDocuments({
      projectId,
      companyId,
      status: CURRENT_STATUS.ACTIVE,
      totalFiles: { $gt: 0 },
    });
    return postCount;
  };

  public static getRecentProjectFiles = async (
    companyId: mongoId,
    projectId: mongoId,
  ) => {
    const recentFileResponse = await PostFiles.find({
      projectId,
      companyId,
      status: CURRENT_STATUS.ACTIVE,
    })
      .select("url fileType size")
      .sort({ createdAt: -1 })
      .limit(5);
    return recentFileResponse;
  };
}
