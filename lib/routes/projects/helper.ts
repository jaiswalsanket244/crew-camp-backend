import {
  CompaniesType,
  ObjectIdType,
  ProjectMemberType,
  ProjectType,
} from "../../utils/interfaces/schemaInterface";
import {
  ProjectMember,
  Project,
  User,
  CompanyMember,
  PostFiles,
} from "../../db";
import {
  convertTime,
  getUserNamePipeline,
  isValidObjectId,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import {
  CURRENT_STATUS,
  MEMBER_TYPE,
  USER_ROLE,
} from "../../utils/enums/enums";
import { FilterQuery, Types } from "mongoose";
import {
  ICompanyProjects,
  ProjectListPathResult,
  ProjectListRow,
} from "../../utils/interfaces/project";
import { applyProjectCreatedAtDateRange, ProjectListSort } from "./listQuery";
import { orderPinnedFirst, ProjectPinHelper } from "./pinsHelper";
import {
  buildProjectListQuery,
  SearchClientService,
  PROJECTS_LIST_REQUEST_TIMEOUT_MS,
} from "../../search";
import { ProjectListQueryInput } from "../../search/types/queries";
import { IImagesPdfFile } from "../../utils/interfaces/files";
import { TRASHBIN_NO_OF_DAYS } from "../../utils/constants/constants";

type mongoId = Types.ObjectId;

// The subset of the `projects` ES document (projectSearchDoc.ts) read by the ES read path.
interface EsProjectSource {
  name?: string;
  location?: string;
  companyId?: string;
  tags?: string[];
  description?: string;
  archivedAt?: Date | null;
  createdAt?: Date;
  membersCount?: number;
  crewsCount?: number;
  commentsCount?: number;
  postsCount?: number;
}

// Minimal hit shape read from the OpenSearch response; the client's generated `HitsMetadata.hits` type is malformed (`Hit & {_source?: T}[]` with an unbound `T`), so we cast to this instead.
export interface EsHit {
  _id?: string;
  _source?: EsProjectSource;
}

export class ProjectHelper {
  public static create = async (
    userId: mongoId,
    companyId: mongoId,
    roles: string,
    body: ProjectType,
  ) => {
    const { name, location, description, tags, coordinates } = body;

    const obj = {
      companyId,
      name,
      description,
      location,
      userId,
      tags,
      coordinates,
    };

    return Project.create(obj);
  };

  public static createByPayLoad = async (body: any) => {
    return Project.create(body);
  };

  public static addToProject = async (projectId: mongoId, userId: mongoId) => {
    return ProjectMember.findOneAndUpdate(
      {
        projectId,
        userId,
      },
      { $set: { status: CURRENT_STATUS.ACTIVE } },
      { upsert: true },
    );
  };

  /**
   * Adds every active member of a company to a project in one bulk upsert.
   * Existing memberships are reactivated rather than duplicated.
   */
  public static addAllCompanyMembersToProject = async (
    projectId: mongoId,
    companyId: mongoId,
  ) => {
    const members = await CompanyMember.find(
      { companyId, status: CURRENT_STATUS.ACTIVE },
      { userId: 1 },
    );

    if (!members.length) return 0;

    await ProjectMember.bulkWrite(
      members.map((member) => ({
        updateOne: {
          filter: { projectId, userId: member.userId },
          update: { $set: { status: CURRENT_STATUS.ACTIVE } },
          upsert: true,
        },
      })),
    );

    return members.length;
  };

  public static findAll = async ({
    userId,
    guest,
  }: {
    userId: Types.ObjectId;
    guest?: boolean;
  }) => {
    const [projectIds, guestProjectIds] = await Promise.all([
      this.getMyProjects(userId),
      guest ? [] : this.getMyGuestProjects(userId),
    ]);

    const [projects, pinnedIds] = await Promise.all([
      Project.find(
        {
          _id: { $in: projectIds, $nin: guestProjectIds },
          archivedAt: { $exists: false },
        },
        { _id: 1, name: 1, projectImage: 1 },
      ).sort({ createdAt: -1 }),
      ProjectPinHelper.listPinnedProjectIds(userId),
    ]);

    // Pins are per-user, so pinned-first ordering can't be a Mongo sort key here. This result set
    // is unpaginated (it is the caller's own project list), so reordering in memory is exact.
    return orderPinnedFirst(projects, pinnedIds);
  };

  public static getProjectsCoordinates = async (userId: Types.ObjectId) => {
    const projectIds = await this.getMyProjects(userId);
    return Project.find(
      {
        _id: { $in: projectIds },
        coordinates: { $exists: true },
        archivedAt: { $exists: false },
      },
      { _id: 1, name: 1, coordinates: 1 },
    ).sort({ createdAt: -1 });
  };

  // V2: includes archived projects and richer fields. Backs the /mapV2 route.
  public static getProjectsCoordinatesV2 = async (userId: Types.ObjectId) => {
    const projectIds = await this.getMyProjects(userId);
    return Project.find(
      {
        _id: { $in: projectIds },
        coordinates: { $exists: true },
      },
      {
        _id: 1,
        name: 1,
        location: 1,
        coordinates: 1,
        archivedAt: 1,
        createdAt: 1,
      },
    ).sort({ createdAt: -1 });
  };

  // V2: company-wide coordinates lookup. Backs the /mapV2 route when the
  // requesting user belongs to a company.
  public static getProjectsCoordinatesByCompany = async (
    companyId: Types.ObjectId,
  ) => {
    return Project.find(
      {
        companyId,
        coordinates: { $exists: true },
      },
      { _id: 1, name: 1, coordinates: 1 },
    ).lean();
  };

  public static getMyProjects = async (
    userId: Types.ObjectId,
    unarchivedProjects?: Types.ObjectId[],
  ) => {
    try {
      const query: any = {
        userId,
        status: CURRENT_STATUS.ACTIVE,
      };
      if (unarchivedProjects) {
        query.projectId = { $in: unarchivedProjects };
      }
      const myProjects = await ProjectMember.find(query, { projectId: 1 }).sort(
        { pinnedAt: -1, updatedAt: -1 },
      );
      const projectIds = myProjects.map((p) => p.projectId);
      return projectIds;
    } catch (er) {
      return [];
    }
  };

  public static getUsersProjects = async (userIds: ObjectIdType[]) => {
    try {
      const query: any = {
        userId: { $in: userIds },
        status: CURRENT_STATUS.ACTIVE,
      };
      const myProjects = await ProjectMember.find(query, { projectId: 1 });
      const projectIds = myProjects.map((p) => p.projectId);
      return projectIds;
    } catch (er) {
      return [];
    }
  };

  public static getMyProjectsArray = async (
    userId: Types.ObjectId,
    archivedProjects?: Types.ObjectId[],
  ) => {
    try {
      if (!userId) return [];
      const myProjects = await this.getMyProjects(userId, archivedProjects);
      const projectIds = myProjects.map((p) => p.toString());
      return projectIds;
    } catch (er) {
      return [];
    }
  };

  public static checkIfImPartOfProject = async (
    userId: Types.ObjectId,
    projectId: Types.ObjectId,
  ) => {
    try {
      if (!userId || !projectId) return false;
      const projects = await ProjectMember.countDocuments({
        userId,
        projectId,
        status: CURRENT_STATUS.ACTIVE,
      });

      return !!projects;
    } catch (er) {
      return [];
    }
  };

  public static getCompanyProjects = async (
    companyIds,
    showArchived?: boolean,
    additionalParameters?: any,
  ) => {
    try {
      if (!companyIds) return [];

      const query: ICompanyProjects = {
        companyId: { $in: companyIds },
        ...(additionalParameters ? additionalParameters : {}),
      };

      if (!showArchived) {
        query.archivedAt = { $exists: false };
      }

      const myProjects = await Project.find(query, { _id: 1 }).sort({
        createdAt: -1,
      });
      return myProjects.map((project) => project._id);
    } catch (er) {
      return [];
    }
  };

  // Fetch just the N most-recent company project IDs the free-tier gate inspects (createdAt desc, no archived filter) so it avoids a full scan + in-memory sort on large tenants.
  public static getRecentCompanyProjectIds = async (
    companyIds,
    limit: number,
  ): Promise<ObjectIdType[]> => {
    try {
      if (!companyIds) return [];
      const rows = await Project.find(
        { companyId: { $in: companyIds } },
        { _id: 1 },
      )
        .sort({ createdAt: -1 })
        .limit(limit);
      return rows.map((project) => project._id);
    } catch (er) {
      return [];
    }
  };

  public static getMineAndCompanyProjects = async (
    companyIds: Types.ObjectId[],
    userId: Types.ObjectId,
    additionalParameters?: any,
  ) => {
    try {
      const companyProjectIds = await this.getCompanyProjects(
        companyIds,
        false,
        additionalParameters ? additionalParameters : {},
      );
      const projectIds = await this.getMyProjects(userId, companyProjectIds);

      return {
        projectIds,
        companyProjectIds,
      };
    } catch (er) {
      return {
        projectIds: [],
        companyProjectIds: [],
      };
    }
  };

  public static getAllProjectsData = async (
    companies?: CompaniesType[],
    projectId?: string,
    search?: string,
    showArchived?: string,
    role?: string,
    filterTags?: string,
    filterProjectsId?: ObjectIdType[],
  ) => {
    const matchQuery = [];
    const userNamePipeline = getUserNamePipeline();
    const Ids = companies.map((c) => c.companyId);

    if (search && search.trim() != "") {
      const text = search.trim();
      matchQuery.push({
        $match: {
          $or: [
            { name: { $regex: text, $options: "i" } },
            {
              description: { $regex: text, $options: "i" },
            },
            {
              location: { $regex: text, $options: "i" },
            },
          ],
        },
      });
    }

    let query: any = { status: CURRENT_STATUS.ACTIVE };
    if (!role || role !== MEMBER_TYPE.GUEST) {
      query = {
        companyId: { $in: Ids },
        status: CURRENT_STATUS.ACTIVE,
      };
    }

    if (projectId) {
      if (isValidObjectId(projectId)) {
        query = {
          _id: ObjectId(projectId),
          status: CURRENT_STATUS.ACTIVE,
        };
      } else {
        return [];
      }
    }

    if (showArchived === "true") {
      query.archivedAt = { $exists: true };
    } else {
      query.archivedAt = { $exists: false };
    }

    if (filterTags) {
      const filterTagsArray = JSON.parse(filterTags);
      if (filterTagsArray.length) {
        query.tags = { $in: filterTagsArray.map((tag) => ObjectId(tag)) };
      }
    }

    if (filterProjectsId && filterProjectsId.length) {
      query._id = { $in: filterProjectsId };
    }

    matchQuery.push({
      $match: query,
    });

    return Project.aggregate([
      ...matchQuery,
      ...userNamePipeline,
      {
        $lookup: {
          from: "projectmembers",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$projectId", "$$projectId"],
                },
                status: CURRENT_STATUS.ACTIVE,
              },
            },
            {
              $count: "totalMembers",
            },
          ],
          as: "members",
        },
      },
      {
        $lookup: {
          from: "crewsprojects",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$projectId", "$$projectId"],
                },
              },
            },
            {
              $lookup: {
                from: "crews",
                localField: "crewId",
                foreignField: "_id",
                as: "crewDetails",
              },
            },
            {
              $unwind: "$crewDetails",
            },
            {
              $match: {
                "crewDetails.status": CURRENT_STATUS.ACTIVE,
              },
            },
            {
              $count: "totalCrews",
            },
          ],
          as: "crews",
        },
      },
      {
        $lookup: {
          from: "comments",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$projectId", "$$projectId"],
                },
                status: CURRENT_STATUS.ACTIVE,
              },
            },
            {
              $count: "totalComments",
            },
          ],
          as: "comments",
        },
      },
      {
        $lookup: {
          from: "postfiles",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$projectId", "$$projectId"],
                },
                companyId: Ids[0],
                status: CURRENT_STATUS.ACTIVE,
              },
            },

            {
              $group: {
                _id: null,
                files: {
                  $push: {
                    $cond: [
                      {
                        $lt: ["$index", 5],
                      },
                      "$$ROOT",
                      [],
                    ],
                  },
                },
                totalcount: {
                  $addToSet: "$postId",
                },
              },
            },
            {
              $project: {
                files: 1,
                totalcount: { $size: "$totalcount" },
              },
            },
          ],
          as: "posts",
        },
      },
      // Pins are per-user now, so they can't be a sort key here (this pipeline has no user
      // context). /all is unpaginated, so the handler reorders pinned rows to the front in JS.
      {
        $sort: {
          updatedAt: -1,
        },
      },
      {
        $project: {
          userName: 1,
          createdAt: 1,
          projectImage: 1,
          name: 1,
          location: 1,
          members: {
            $arrayElemAt: ["$members.totalMembers", 0],
          },
          crews: {
            $arrayElemAt: ["$crews.totalCrews", 0],
          },
          comments: {
            $arrayElemAt: ["$comments.totalComments", 0],
          },
          posts: {
            $arrayElemAt: ["$posts.totalcount", 0],
          },
          recentPosts: {
            $arrayElemAt: ["$posts.files", 0],
          },
          companyId: 1,
          tags: 1,
          description: 1,
          coordinates: 1,
          archivedAt: 1,
        },
      },
    ]);
  };

  public static getAllProjectsDataV2 = async (
    companies?: CompaniesType[],
    projectId?: string,
    search?: string,
    showArchived?: string,
    role?: string,
    filterTags?: string,
    filterProjectsId?: ObjectIdType[],
    page?: number,
    pageSize?: number,
    skips?: number,
    userId?: Types.ObjectId,
    dateRange?: { startDate: Date; endDate: Date },
    sort?: ProjectListSort,
    // Per-user pinned ids, excluded here so the handler can splice them ahead of this page
    // without the same project appearing twice.
    excludeProjectIds?: ObjectIdType[],
  ) => {
    const Ids = companies.map((c) => c.companyId);

    let query: any = { status: CURRENT_STATUS.ACTIVE };
    if (!role || role !== MEMBER_TYPE.GUEST) {
      query = {
        companyId: Ids[0],
        status: CURRENT_STATUS.ACTIVE,
      };
    }

    if (projectId) {
      if (isValidObjectId(projectId)) {
        query = {
          _id: ObjectId(projectId),
          status: CURRENT_STATUS.ACTIVE,
        };
      } else {
        return [];
      }
    }

    if (showArchived === "true") {
      query.archivedAt = { $exists: true };
    } else {
      query.archivedAt = { $exists: false };
    }

    if (filterTags) {
      const filterTagsArray = JSON.parse(filterTags);
      if (filterTagsArray.length) {
        query.tags = { $in: filterTagsArray.map((tag) => ObjectId(tag)) };
      }
    }

    if (filterProjectsId && filterProjectsId.length && !projectId) {
      query._id = { $in: filterProjectsId };
    }

    if (search && search.trim() != "") {
      const text = search.trim();
      query["$or"] = [
        { name: { $regex: text, $options: "i" } },
        {
          description: { $regex: text, $options: "i" },
        },
        {
          location: { $regex: text, $options: "i" },
        },
      ];
    }

    applyProjectCreatedAtDateRange(query, dateRange);

    // $nin merges with the $in above rather than replacing it, so an exclusion still narrows a
    // role-restricted filterProjectsId set instead of widening it.
    if (excludeProjectIds && excludeProjectIds.length) {
      query._id = { ...(query._id ?? {}), $nin: excludeProjectIds };
    }

    const projectsAggregate = Project.aggregate([
      { $match: query },
      {
        $sort: sort?.mongoSort ?? {
          updatedAt: -1,
        },
      },
      { $skip: skips },
      { $limit: pageSize },
      {
        $project: {
          userName: 1,
          createdAt: 1,
          projectImage: 1,
          name: 1,
          location: 1,
          companyId: 1,
          tags: 1,
          description: 1,
          coordinates: 1,
          archivedAt: 1,
        },
      },
    ]);
    // Name sort is case-insensitive (strength 2) so "apple" doesn't sort after "Zebra"; date sorts keep the default binary comparison.
    if (sort?.caseInsensitive) {
      projectsAggregate.collation({ locale: "en", strength: 2 });
    }

    const [total, projects] = await Promise.all([
      Project.countDocuments(query),
      projectsAggregate,
    ]);

    const paginationResult = {
      projects,
      page,
      pageSize,
      totalCount: total,
      totalPages: Math.ceil(total / pageSize),
    };
    return paginationResult;
  };

  // Batched form of getRecentProjectFiles: the top-5 PostFiles per project for ALL the given project ids in ONE aggregation (NOT per-row fan-out). Mirrors getRecentProjectFiles' { _id, url, fileType, size } shape, createdAt desc, ACTIVE-only (status filter matches getRecentProjectFiles for read parity). Returns a map keyed by the projectId string. (Lives here, not PostsHelper, to avoid a projects↔posts circular import.)
  public static getRecentProjectFilesBatch = async (
    companyId: ObjectIdType,
    projectIds: ObjectIdType[],
  ): Promise<Record<string, unknown[]>> => {
    if (!projectIds.length) {
      return {};
    }
    const grouped = await PostFiles.aggregate([
      {
        $match: {
          projectId: { $in: projectIds },
          companyId,
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$projectId",
          files: {
            $push: {
              _id: "$_id",
              url: "$url",
              fileType: "$fileType",
              size: "$size",
            },
          },
        },
      },
      { $project: { files: { $slice: ["$files", 5] } } },
    ]);
    const map: Record<string, unknown[]> = {};
    grouped.forEach((g) => {
      map[g._id.toString()] = g.files;
    });
    return map;
  };

  // Executes ONE projects.list search and returns raw hits + total. Split out of
  // getAllProjectsDataV2FromES so the pinned-rows fetch and the paged fetch can each run a
  // search while the expensive batched supplements below still run exactly once, over the
  // merged hit set.
  public static fetchProjectListHits = async (
    input: ProjectListQueryInput,
  ): Promise<{ hits: EsHit[]; totalCount: number }> => {
    const query = buildProjectListQuery(input);
    const response = await SearchClientService.getInstance().search(query, {
      requestTimeout: PROJECTS_LIST_REQUEST_TIMEOUT_MS,
    });
    const hitsMeta = response?.body?.hits;
    if (!hitsMeta || !Array.isArray(hitsMeta.hits)) {
      throw new Error("Malformed OpenSearch response: missing hits");
    }
    const totalRaw = hitsMeta.total;
    return {
      hits: hitsMeta.hits as unknown as EsHit[],
      totalCount:
        typeof totalRaw === "number" ? totalRaw : (totalRaw?.value ?? 0),
    };
  };

  // ES read path for GET /api/projects/list. Runs buildProjectListQuery → ES, then builds the SAME augmented rows as the Mongo path using the index's denormalized counts (no per-row Mongo fan-out), supplemented by ONE batched Project.find (projectImage/coordinates) + ONE batched recentPosts aggregation. GUEST + external requests never reach here (handler routes them to Mongo), so isGuest is always false and the per-row GUEST canAccess block is N/A.
  // `preHits` / `extraTotal` carry the caller's pinned rows: the handler resolves them with its
  // own search, and they are prepended to the page here so the supplements cover them too.
  public static getAllProjectsDataV2FromES = async (
    input: ProjectListQueryInput,
    ctx: {
      companyProjects: ObjectIdType[];
      isSubscriptionActive: boolean;
      companyIds: string[];
      userCompanyRole?: string;
      preHits?: EsHit[];
      extraTotal?: number;
      pinnedAtById?: Record<string, Date>;
    },
  ): Promise<ProjectListPathResult> => {
    const paged = await ProjectHelper.fetchProjectListHits(input);
    const hits = [...(ctx.preHits ?? []), ...paged.hits];
    const totalCount = paged.totalCount + (ctx.extraTotal ?? 0);

    const hitIds = hits
      .map((h) => h._id)
      .filter((id): id is string => Boolean(id));
    const hitObjectIds = hitIds.map((id) => ObjectId(id));

    const [scalarRows, recentMap, memberRows] = await Promise.all([
      Project.find(
        { _id: { $in: hitObjectIds } },
        { projectImage: 1, coordinates: 1 },
      ).lean(),
      ProjectHelper.getRecentProjectFilesBatch(input.companyId, hitObjectIds),
      // Membership for THIS page's hits only — keeps isMember exact while avoiding a full ProjectMember scan for power users.
      ProjectMember.find(
        {
          userId: input.userId,
          projectId: { $in: hitObjectIds },
          status: CURRENT_STATUS.ACTIVE,
        },
        { projectId: 1 },
      ).lean(),
    ]);
    const memberIdSet = new Set(
      (memberRows as Array<{ projectId: ObjectIdType }>).map((m) =>
        m.projectId.toString(),
      ),
    );
    const scalarsById: Record<
      string,
      { projectImage?: string; coordinates?: ProjectListRow["coordinates"] }
    > = {};
    scalarRows.forEach((r) => {
      scalarsById[r._id.toString()] = {
        projectImage: r.projectImage,
        coordinates: r.coordinates,
      };
    });

    const allowedProjects = ctx.companyProjects
      .slice(0, 10)
      .map((c) => c.toString());

    const rows: ProjectListRow[] = hits.map((hit) => {
      const src = (hit._source ?? {}) as EsProjectSource;
      const id = (hit._id ?? "").toString();
      const scalar = scalarsById[id] ?? {};

      // canJoin — replicate routes.ts (the base row has no isMember, so !p.isMember is always true → LIMITED/CREW always added to notAllowed; quirk preserved verbatim for parity).
      let canJoin = ctx.companyIds.includes((src.companyId ?? "").toString());
      const notAllowed: string[] = [
        USER_ROLE.ADMIN,
        USER_ROLE.LIMITED,
        USER_ROLE.CREW,
      ];
      if (ctx.userCompanyRole && notAllowed.includes(ctx.userCompanyRole)) {
        canJoin = false;
      }

      // canAccess — non-GUEST branch only; GUEST never reaches the ES path.
      let canAccess = true;
      if (!ctx.isSubscriptionActive && !allowedProjects.includes(id)) {
        canAccess = false;
      }

      const isMember = memberIdSet.has(id);
      return {
        _id: id,
        name: src.name,
        location: src.location,
        companyId: src.companyId,
        tags: src.tags,
        description: src.description,
        // Per-user, resolved from the projectpins collection — the indexed src.pinnedAt is the
        // retired company-wide field and is deliberately ignored.
        pinnedAt: ctx.pinnedAtById?.[id] ?? null,
        coordinates: scalar.coordinates,
        archivedAt: src.archivedAt ?? null,
        projectImage: scalar.projectImage,
        createdAt: convertTime(src.createdAt),
        members: src.membersCount ?? 0,
        crews: src.crewsCount ?? 0,
        comments: src.commentsCount ?? 0,
        posts: src.postsCount ?? 0,
        recentPosts: recentMap[id] ?? [],
        isMember,
        isGuest: false,
        allowComment: isMember,
        canJoin,
        canAccess,
      };
    });

    return {
      rows,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / input.pageSize),
      },
    };
  };

  public static getProjectDetails = async (
    projectId: string,
    companyId: Types.ObjectId,
  ) => {
    if (!projectId || !isValidObjectId(projectId)) {
      return [];
    }

    const userNamePipeline = getUserNamePipeline();

    return Project.aggregate([
      {
        $match: {
          status: CURRENT_STATUS.ACTIVE,
          _id: ObjectId(projectId),
        },
      },
      ...userNamePipeline,
      {
        $lookup: {
          from: "projectmembers",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$projectId", "$$projectId"],
                },
                status: CURRENT_STATUS.ACTIVE,
              },
            },
            {
              $count: "totalMembers",
            },
          ],
          as: "members",
        },
      },
      {
        $lookup: {
          from: "crewsprojects",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$projectId", "$$projectId"],
                },
              },
            },
            {
              $lookup: {
                from: "crews",
                localField: "crewId",
                foreignField: "_id",
                as: "crewDetails",
              },
            },
            {
              $unwind: "$crewDetails",
            },
            {
              $match: {
                "crewDetails.status": CURRENT_STATUS.ACTIVE,
              },
            },
            {
              $count: "totalCrews",
            },
          ],
          as: "crews",
        },
      },
      {
        $lookup: {
          from: "comments",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$projectId", "$$projectId"],
                },
                status: CURRENT_STATUS.ACTIVE,
              },
            },
            {
              $count: "totalComments",
            },
          ],
          as: "comments",
        },
      },
      {
        $lookup: {
          from: "postfiles",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$projectId", "$$projectId"],
                },
                companyId: companyId,
                status: CURRENT_STATUS.ACTIVE,
              },
            },
            {
              $group: {
                _id: null,
                files: {
                  $push: {
                    $cond: [
                      {
                        $lt: ["$index", 5],
                      },
                      "$files",
                      [],
                    ],
                  },
                },
                totalcount: {
                  $addToSet: "$postId",
                },
              },
            },
            {
              $project: {
                files: 1,
                totalcount: { $size: "$totalcount" },
              },
            },
          ],
          as: "posts",
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      },
      {
        $project: {
          userName: 1,
          createdAt: 1,
          projectImage: 1,
          name: 1,
          location: 1,
          members: {
            $arrayElemAt: ["$members.totalMembers", 0],
          },
          crews: {
            $arrayElemAt: ["$crews.totalCrews", 0],
          },
          comments: {
            $arrayElemAt: ["$comments.totalComments", 0],
          },
          posts: {
            $arrayElemAt: ["$posts.totalcount", 0],
          },
          companyId: 1,
          tags: 1,
          description: 1,
          coordinates: 1,
          archivedAt: 1,
          // Lets the client surface "merged into <project>" on a project that was
          // consolidated away instead of showing an empty archived project.
          mergedInto: 1,
          mergedAt: 1,
        },
      },
    ]);
  };

  public static getCompanyId = async (projectId) => {
    return Project.findById(projectId, { companyId: 1 });
  };

  /**
   * Projects sitting in the bin for the given companies, newest deletion first.
   * purgeAt tells the client when each one is due to be permanently removed, so
   * the bin can show a countdown rather than a bare date.
   */
  public static getDeletedProjects = async (companyIds: ObjectIdType[]) => {
    const projects = await Project.find(
      {
        companyId: { $in: companyIds },
        status: CURRENT_STATUS.DELETED,
      },
      {
        name: 1,
        location: 1,
        description: 1,
        companyId: 1,
        projectImage: 1,
        deletedAt: 1,
        createdAt: 1,
      },
    )
      .sort({ deletedAt: -1 })
      .lean();

    return projects.map((project) => ({
      ...project,
      purgeAt: project.deletedAt
        ? new Date(
            new Date(project.deletedAt).getTime() +
              TRASHBIN_NO_OF_DAYS * 24 * 60 * 60 * 1000,
          )
        : null,
    }));
  };

  // Scope + bin state for the delete/restore guards. Separate from getCompanyId
  // so that widely-used projection stays untouched.
  public static getProjectForDelete = async (projectId: ObjectIdType) => {
    return Project.findById(projectId, {
      companyId: 1,
      status: 1,
      deletedAt: 1,
      name: 1,
    });
  };

  public static joinProject = async (userId, projectId, type) => {
    return ProjectMember.findOneAndUpdate(
      {
        projectId,
        userId,
      },
      { $set: { status: CURRENT_STATUS.ACTIVE, type } },
      { upsert: true },
    );
  };

  public static leaveProject = async (userId, projectId) => {
    return ProjectMember.findOneAndUpdate(
      {
        projectId,
        userId,
      },
      { $set: { status: CURRENT_STATUS.INACTIVE } },
    );
  };

  public static getProjectMembers = async (projectId) => {
    if (!projectId) return [];
    const userNamePipeline = getUserNamePipeline();

    return ProjectMember.aggregate([
      {
        $match: {
          projectId: ObjectId(projectId),
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      ...userNamePipeline,
      {
        $project: {
          userName: 1,
          _id: "$userId",
          profileImage: 1,
          userRole: 1,
          roles: 1,
          type: 1,
        },
      },
    ]);
  };

  public static put = async ({ projectId, update }) => {
    return Project.findByIdAndUpdate(projectId, { $set: update });
  };

  public static unset = async ({
    projectId,
    fields,
  }: {
    projectId: mongoId;
    fields: object;
  }) => {
    return Project.findByIdAndUpdate(projectId, { $unset: fields });
  };

  public static user = async (userId, companyId) => {
    return Promise.all([
      User.findById(userId, {
        name: 1,
        email: 1,
        phone: 1,
        profileImage: 1,
        userRole: 1,
        lastActivity: 1,
      }).lean(),
      CompanyMember.findOne(
        { userId, companyId },
        { createdAt: 1, role: 1 },
      ).lean(),
      Project.aggregate([
        {
          $match: {
            companyId: ObjectId(companyId),
            status: CURRENT_STATUS.ACTIVE,
            archivedAt: { $exists: false },
          },
        },
        {
          $lookup: {
            from: "projectmembers",
            let: { projectId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ["$projectId", "$$projectId"],
                  },
                  status: CURRENT_STATUS.ACTIVE,
                  userId: ObjectId(userId),
                },
              },
            ],
            as: "member",
          },
        },
        {
          $project: {
            name: 1,
            lastActivity: 1,
            isMember: {
              $cond: [
                {
                  $eq: [
                    { $arrayElemAt: ["$member.status", 0] },
                    CURRENT_STATUS.ACTIVE,
                  ],
                },
                true,
                false,
              ],
            },
            role: {
              $cond: [
                {
                  $eq: [
                    { $arrayElemAt: ["$member.status", 0] },
                    CURRENT_STATUS.ACTIVE,
                  ],
                },
                { $arrayElemAt: ["$member.role", 0] },
                "Not a member",
              ],
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
  };

  public static removeAccount = async (companyId, userId) => {
    const projects = await Project.find({ companyId }, { _id: 1 });
    const projectIds = projects.map((p) => p._id);

    return ProjectMember.findOneAndUpdate(
      {
        projectId: { $in: projectIds },
        userId,
      },
      {
        $set: {
          status: CURRENT_STATUS.INACTIVE,
        },
      },
    );
  };

  public static getCompanyData = async (companyIds) => {
    return Project.find(
      { companyId: { $in: companyIds }, archivedAt: { $exists: false } },
      { name: 1, createdAt: 1 },
    )
      .sort({ createdAt: -1 })
      .lean();
  };

  public static getProjectData = async (projectId) => {
    return Project.findById(projectId);
  };

  public static getpeople = async (
    companyId: ObjectIdType,
    rolesExclude?: string,
  ) => {
    const userNamePipeline = getUserNamePipeline();

    return CompanyMember.aggregate([
      {
        $match: {
          companyId,
          status: CURRENT_STATUS.ACTIVE,
          ...(rolesExclude ? { role: { $ne: rolesExclude } } : {}),
        },
      },
      ...userNamePipeline,
      {
        $project: {
          _id: "$userId",
          userName: 1,
          profileImage: 1,
          userRole: 1,
          roles: 1,
          lastActivity: 1,
        },
      },
      {
        $sort: {
          userName: 1,
        },
      },
    ]);
  };

  public static getUserProjectData = ({ projectId, userId }) => {
    return ProjectMember.findOne({
      projectId,
      userId,
      status: CURRENT_STATUS.ACTIVE,
    });
  };

  public static getMyGuestProjects = async (userId: Types.ObjectId) => {
    try {
      const query: any = {
        userId,
        status: CURRENT_STATUS.ACTIVE,
        type: MEMBER_TYPE.GUEST,
      };
      const myProjects = await ProjectMember.find(query, { projectId: 1 });
      const projectIds = myProjects.map((p) => p.projectId);
      return projectIds;
    } catch (er) {
      return [];
    }
  };
  public static getMyProjectsWithoutGuest = async (userId: Types.ObjectId) => {
    try {
      const query: any = {
        userId,
        status: CURRENT_STATUS.ACTIVE,
        type: { $ne: MEMBER_TYPE.GUEST },
      };
      const myProjects = await ProjectMember.find(query, { projectId: 1 });
      const projectIds = myProjects.map((p) => p.projectId);
      return projectIds;
    } catch (er) {
      return [];
    }
  };

  public static updateProjectInfo = async (projectId: mongoId) => {
    return Project.findByIdAndUpdate(projectId, {
      $set: { updatedAt: new Date() },
    });
  };

  public static checkIfPartOfProject = async (
    projectId: mongoId,
    userId: mongoId,
  ) => {
    return ProjectMember.countDocuments({ projectId, userId });
  };

  public static getProjectMembersCount = (projectId: mongoId) => {
    return ProjectMember.countDocuments({
      projectId,
      status: CURRENT_STATUS.ACTIVE,
    });
  };

  public static getProjectPrintAddress = async (
    projectId: mongoId,
    companyId: mongoId,
  ): Promise<string | undefined> => {
    const project = await Project.findOne(
      { _id: projectId, companyId },
      { location: 1 },
    ).lean();
    return project?.location?.trim() || undefined;
  };

  // Post files for the selected-images PDF, with the uploader's name resolved
  // so the caption block can be rendered without a second round trip.
  public static getPostFiles = (
    fileIds: mongoId[],
    companyId: mongoId,
    projectId: mongoId,
  ): Promise<IImagesPdfFile[]> => {
    return PostFiles.aggregate([
      {
        $match: {
          _id: { $in: fileIds },
          companyId,
          projectId,
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      ...getUserNamePipeline(),
      {
        $project: {
          url: 1,
          postId: 1,
          location: 1,
          timestamp: 1,
          uploadedAt: 1,
          createdAt: 1,
          userName: 1,
          postCreatedAt: `$postSortDate`,
        },
      },
    ]);
  };

  // Covered by { userId: 1, status: 1, projectId: 1 }: suppressing _id keeps the
  // projection inside the index, so this is answered from index keys alone with
  // no document fetches. .lean() skips hydrating a Mongoose Document per row.
  public static getMyProjectsArrayV2 = async (
    userId: Types.ObjectId,
  ): Promise<Types.ObjectId[]> => {
    // Mongoose strips an undefined userId, which would turn this into a
    // company-wide scan of every ACTIVE membership.
    if (!userId) return [];

    try {
      const query: FilterQuery<ProjectMemberType> = {
        userId,
        status: CURRENT_STATUS.ACTIVE,
      };

      const myProjects = await ProjectMember.aggregate([
        { $match: query },
        { $project: { projectId: 1, _id: 0 } },
      ]);

      return myProjects.map((p) => p.projectId);
    } catch (er) {
      return [];
    }
  };
}
