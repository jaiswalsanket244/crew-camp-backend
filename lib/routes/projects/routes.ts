import * as express from "express";
import * as status from "http-status";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { EsHit, ProjectHelper } from "./helper";
import { orderPinnedFirst, ProjectPinHelper } from "./pinsHelper";
import {
  MAX_PINS_PER_USER,
  TRASHBIN_NO_OF_DAYS,
} from "../../utils/constants/constants";
import { ProjectService } from "../../services/projects";
import { IMergeProjectDoc, ProjectMergeHelper } from "./merge";
import { reindexProjectById } from "../../search/sync/projectUpdates";
import {
  MERGE_CONFLICT_FIELD,
  MERGE_CONFLICT_FIELDS,
  MERGE_FIELD_CHOICES,
} from "../../utils/enums/projectMerge";
import { instrumentBaselineLatency } from "../../search/baselineLatency";
import { searchWithFallback } from "../../search";
import { ProjectListQueryInput } from "../../search/types/queries";
import {
  IProjectMergeResolutions,
  ProjectListPathResult,
} from "../../utils/interfaces/project";
import { ObjectIdType, UserType } from "../../utils/interfaces/schemaInterface";
import {
  convertTime,
  escapeRegExp,
  getActiveAdminCompanies,
  getDayEnd,
  getDayStart,
  isValidObjectId,
  ObjectId,
  verifyToken,
} from "../../utils/helpers/commonHelper";
import {
  CURRENT_STATUS,
  MEMBER_TYPE,
  NotificationCategory,
  NotificationMessageKey,
  USER_ROLE,
} from "../../utils/enums/enums";
import { translate } from "../../utils/i18n";
import { Validator } from "node-input-validator";
import { NotificationsHelpers } from "../notifications/helpers";
import { config } from "../../utils/configuration/config";
import { CompanyHelpers } from "../company/helpers";
import { InviteUsersHelpers } from "../inviteUser/helpers";
import { UserHelper } from "../user/helper";
import { SubscriptionService } from "../../services/subscriptionService";
import { isStandardAndAbove } from "../../utils/helpers/users";
import { PostsHelper } from "../posts/helper";
import { ProjectDetailTab } from "../../utils/enums/projectDetailTab";
import { CHECKLIST_STATUS, CHECKLIST_TYPE } from "../../utils/enums/checklist";
import { ChecklistHelper } from "../checklist/helper";
import { ProjectReportsHelpers } from "../projectReport/helpers";
import { ProjectDocumentHelpers } from "../projectDocuments/helpers";
import { DOCUMENT_TYPES } from "../projectDocuments/listQuery";
import { ProjectTasksHelper } from "../projectTasks/helper";
import { ProjectNotesHelper } from "../projectNotes/helper";
import { FilesHelper } from "../file/helper";
import { onProjectCreated, onProjectUpdated } from "../../integrations/hooks";
import { parseProjectListDateRange } from "./dateRange";
import { ProjectListSort, resolveProjectListSort } from "./listQuery";
import { CrewsHelper } from "../crews/helper";
import { CommentHelper } from "../comments/helper";
import { PDFService } from "../../services/pdfService";
import {
  DEFAULT_PHOTOS_PER_PAGE,
  PHOTOS_PER_PAGE_OPTIONS,
  PRINT_PHOTO_CAP,
} from "../../utils/constants/printPhotos";
import { IImagesPdfFile } from "../../utils/interfaces/files";
import { UploadsScopeUser } from "../../utils/interfaces/post";
import {
  MyUploadsQuery,
  PaginatedSearchQuery,
} from "../../utils/interfaces/query";

// Bound on user-supplied search text before it reaches $regex — matches the cap
// the checklist, task and report list queries apply.
const SEARCH_MAX_LENGTH = 100;

export class ProjectRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { _id, companyId, roles } = req.user;

      if (roles === USER_ROLE.CREW) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "you are not authorized to create projects",
        });
      }

      const project = await ProjectHelper.create(
        _id,
        companyId,
        roles,
        req.body,
      );

      await ProjectHelper.addToProject(project._id, _id);
      const users = await ProjectHelper.getpeople(req.user.companyId);
      await Promise.all(
        users.map(async (user) => {
          if (isStandardAndAbove(user.roles)) {
            ProjectHelper.addToProject(project._id, user._id);
          }
        }),
      );

      const { addUsers, inviteCodes } = req.body;

      if (inviteCodes?.length) {
        inviteCodes.map(async (code) => {
          await InviteUsersHelpers.addProjectIdToInvite(code, project._id);
        });
      }

      const createPostNotification = this.invokeNotications;

      if (addUsers?.length) {
        addUsers.forEach(async (userId) => {
          await ProjectHelper.addToProject(project._id, userId);
          await createPostNotification(project._id, userId, req.user);
          return;
        });
      }

      // Trigger CRM integration sync (async, non-blocking)
      onProjectCreated(project._id).catch((err) => {
        console.error("Project integration hook error:", err);
      });

      return SuccessResponse(res, status.OK, {
        message: "project created succesfully",
        data: { projectId: project._id },
      });
    } catch (error) {
      next(error);
    }
  };

  public static getMyProjects = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const guest = req.query.guest;
      const projects = await ProjectHelper.findAll({ userId, guest });

      return SuccessResponse(res, status.OK, {
        data: projects,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getMyProjectsMap = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;

      const projects = await ProjectHelper.getProjectsCoordinates(userId);

      return SuccessResponse(res, status.OK, {
        data: projects,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getMyProjectsMapV2 = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const companyId = req.user?.companies?.[0]?.companyId;

      const projects = companyId
        ? await ProjectHelper.getProjectsCoordinatesByCompany(companyId)
        : await ProjectHelper.getProjectsCoordinatesV2(userId);

      return SuccessResponse(res, status.OK, {
        data: projects,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getAllData = async (
    req: AuthenticatedRequest & {
      query: { projectId: string; search: string };
    },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const user: UserType = req.user;
      const { projectId, search, showArchived, role, filterTags, filterUsers } =
        req.query;
      const companyIds = user.companies.map((c) => c.companyId.toString());

      let filterProjectsId = [];

      if (role === MEMBER_TYPE.GUEST) {
        filterProjectsId = await ProjectHelper.getMyGuestProjects(user._id);
      }

      if (filterUsers) {
        const filterUsersArray = JSON.parse(filterUsers).map((filterUser) =>
          ObjectId(filterUser),
        );
        if (filterUsersArray.length) {
          const filterUsersProjects =
            await ProjectHelper.getUsersProjects(filterUsersArray);
          if (role === MEMBER_TYPE.GUEST) {
            filterProjectsId = filterProjectsId.filter((projectId) =>
              filterUsersProjects.includes(projectId),
            );
          } else {
            filterProjectsId = filterUsersProjects;
          }
        }
      }

      const [rawProjects, myProjectIds, companyProjects, pinnedRows] =
        await Promise.all([
          role !== MEMBER_TYPE.GUEST ||
          (role === MEMBER_TYPE.GUEST && filterProjectsId.length)
            ? ProjectHelper.getAllProjectsData(
                user.companies,
                projectId,
                search,
                showArchived,
                role,
                filterTags,
                filterProjectsId,
              )
            : [],
          ProjectHelper.getMyProjectsArray(user._id),
          ProjectHelper.getCompanyProjects(companyIds, true),
          ProjectPinHelper.listPinned(user._id, user.companyId),
        ]);

      // /all is unpaginated, so the caller's pins can be reordered to the front exactly.
      const projects = orderPinnedFirst(
        rawProjects,
        pinnedRows.map((r) => r.projectId),
      );
      const pinnedAtMap: Record<string, Date> = {};
      pinnedRows.forEach((r) => {
        pinnedAtMap[r.projectId.toString()] = r.pinnedAt;
      });

      const admin = await CompanyHelpers.getCompanyAdminId(user.companyId);

      const isSubscriptionActive = admin?.userId
        ? await UserHelper.isAdminSubscriptionActive(admin?.userId)
        : false;

      const op = (
        await Promise.all(
          projects.map(async (p) => {
            let canJoin = companyIds.includes(p.companyId.toString());
            const notAllowed: string[] = [USER_ROLE.ADMIN];
            const isMember = myProjectIds.includes(p._id.toString());
            if (!isMember) {
              notAllowed.push(USER_ROLE.LIMITED);
              notAllowed.push(USER_ROLE.CREW);
            }
            if (notAllowed.includes(user?.companies?.[0]?.role)) {
              canJoin = false;
            }

            let canPush = true;
            const pushhable: string[] = [USER_ROLE.LIMITED, USER_ROLE.CREW];
            if (pushhable.includes(user?.companies?.[0]?.role) && !isMember) {
              canPush = false;
            }
            let canAccess = true;

            if (role === MEMBER_TYPE.GUEST) {
              const [subscriptionActive, companiesProjectId] =
                await Promise.all([
                  SubscriptionService.isSubscriptionActive(p.companyId),
                  ProjectHelper.getCompanyProjects([p.companyId], true),
                ]);
              if (!subscriptionActive) {
                const allowedProjects = companiesProjectId
                  .slice(0, 10)
                  .map((c) => c.toString());
                if (!allowedProjects.includes(p._id.toString())) {
                  canAccess = false;
                }
              }
            } else {
              if (!isSubscriptionActive) {
                const allowedProjects = companyProjects
                  .slice(0, 10)
                  .map((c) => c.toString());
                if (!allowedProjects.includes(p._id.toString())) {
                  canAccess = false;
                }
              }
            }

            let isGuest = false;

            const projectAccess = await ProjectHelper.getUserProjectData({
              projectId: p._id,
              userId: user._id,
            });

            if (projectAccess && projectAccess.type == MEMBER_TYPE.GUEST) {
              isGuest = true;
            }

            // Per-user pin timestamp; the projects collection no longer carries the field.
            const pinnedAt = pinnedAtMap[p._id.toString()] ?? null;

            if (canPush) {
              if (req.isExternalRequest) {
                delete p.projectImage;
                delete p.companyId;
                return {
                  ...p,
                  pinnedAt,
                  recentPosts: p?.recentPosts?.flat().slice(0, 5),
                };
              }
              return {
                ...p,
                pinnedAt,
                createdAt: convertTime(p.createdAt),
                allowComment: myProjectIds.includes(p._id.toString()),
                isMember,
                canJoin,
                canAccess,
                recentPosts: p?.recentPosts?.flat().slice(0, 5),
                isGuest,
              };
            }
          }),
        )
      ).filter(Boolean);

      return SuccessResponse(res, status.OK, {
        data: op,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getAllDataV2 = async (
    req: AuthenticatedRequest & {
      query: { projectId: string; search: string };
    },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      instrumentBaselineLatency(res, "projects.list", () =>
        req.user?.companyId?.toString(),
      );
      const user: UserType = req.user;
      const {
        projectId,
        search,
        showArchived,
        role,
        filterTags,
        filterUsers,
        sortBy,
        sortOrder,
      } = req.query;

      if (projectId && !isValidObjectId(projectId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid projectId",
        });
      }

      let listSort: ProjectListSort;
      try {
        listSort = resolveProjectListSort(sortBy, sortOrder);
      } catch (error) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: error?.message || "Invalid sort payload",
        });
      }

      const query = { ...req.query } as any;
      query.page = Number(query.page) || 1;
      query.pageSize = Number(query.pageSize) || 500;
      query.skips = (query.page - 1) * query.pageSize;

      if (query?.dateRange) {
        try {
          query.dateRange = parseProjectListDateRange(query.dateRange);
        } catch (error) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: error?.message || "Invalid dateRange payload",
          });
        }
      }

      const companyIds = user?.companies?.map((c) => c.companyId.toString());

      let filterProjectsId: ObjectIdType[] = [];
      const userRole = user?.companies?.[0]?.role;
      const isRestrictedRole =
        userRole === USER_ROLE.LIMITED || userRole === USER_ROLE.CREW;

      if (role === MEMBER_TYPE.GUEST) {
        filterProjectsId = await ProjectHelper.getMyGuestProjects(user._id);
      }

      if (
        user?.companies?.[0]?.role === USER_ROLE.LIMITED ||
        user?.companies?.[0]?.role === USER_ROLE.CREW
      ) {
        const myProjectsWithoutGuest =
          await ProjectHelper.getMyProjectsWithoutGuest(user._id);

        if (role !== MEMBER_TYPE.GUEST) {
          filterProjectsId = myProjectsWithoutGuest;
        }
      }

      if (filterUsers) {
        const filterUsersArray = JSON.parse(filterUsers).map((filterUser) =>
          ObjectId(filterUser),
        );
        if (filterUsersArray.length) {
          const filterUsersProjects =
            await ProjectHelper.getUsersProjects(filterUsersArray);
          if (filterProjectsId.length) {
            filterProjectsId = filterProjectsId.filter((projectId) =>
              filterUsersProjects.includes(projectId),
            );
          } else {
            filterProjectsId = filterUsersProjects;
          }
        }
      }

      // companyProjects feeds only the free-tier gate, so fetch nothing (active sub) or just the 10 it inspects (free-tier); membership is resolved per-path below to avoid loading the full list on ES-served requests.
      const isSubscriptionActive = await UserHelper.isAdminSubscriptionActive(
        user.adminId,
      );
      const companyProjects = isSubscriptionActive
        ? []
        : await ProjectHelper.getRecentCompanyProjectIds(companyIds, 10);

      // ---- Per-user pins -------------------------------------------------------------------
      // Pinned projects lead the list for THIS caller only. Resolved once here (one indexed
      // lookup, capped at MAX_PINS_PER_USER) and spliced ahead of the paged query by both read
      // paths, which exclude them so nothing appears twice. Skipped for a single-project lookup,
      // where ordering is meaningless.
      const pinnedRows =
        projectId || !user.companies?.[0]?.companyId
          ? []
          : await ProjectPinHelper.listPinned(
              user._id,
              user.companies[0].companyId,
            );

      // Pins MUST respect the id restriction computed above (restricted roles, filterUsers):
      // intersect, never replace, or a pin could resurface a project the caller has lost access to.
      const filterProjectsIdSet = new Set(
        filterProjectsId.map((id) => id.toString()),
      );
      const pinCandidates = filterProjectsId.length
        ? pinnedRows.filter((r) =>
            filterProjectsIdSet.has(r.projectId.toString()),
          )
        : pinnedRows;
      const pinCandidateIds = pinCandidates.map((r) => r.projectId);
      const pinnedAtById: Record<string, Date> = {};
      pinCandidates.forEach((r) => {
        pinnedAtById[r.projectId.toString()] = r.pinnedAt;
      });

      // Splits the requested page between the pinned block (which always leads, in pin order)
      // and the paged unpinned query. `matched` is the number of pins that actually survive the
      // active filters — a pinned project that fails the tag/search/archived filter must not
      // jump the queue, and must not shift the offset either.
      const splitPage = (matched: number) => {
        const pinnedTake = Math.max(
          0,
          Math.min(query.pageSize, matched - query.skips),
        );
        return {
          unpinnedSkip: Math.max(0, query.skips - matched),
          unpinnedLimit: query.pageSize - pinnedTake,
        };
      };

      // Mongo path: getAllProjectsDataV2 + the per-row sub-count fan-out + access augmentation. Returns null for the projectId-invalid edge (getAllProjectsDataV2 → []), preserving the "send nothing" behavior.
      const mongoCall = async (): Promise<ProjectListPathResult | null> => {
        // Fetch the full membership list HERE (not shared setup) so ES-served requests, which scope membership to the page's hits, never pay for it.
        const myProjectIds = await ProjectHelper.getMyProjectsArray(user._id);
        const canQuery =
          (role !== MEMBER_TYPE.GUEST && !isRestrictedRole) ||
          filterProjectsId.length > 0;

        // Pinned rows first, through the SAME filter set (so a pin that fails the active filters
        // is simply absent), then reordered to pin order.
        let pinnedProjects = [];
        if (canQuery && pinCandidateIds.length) {
          const pinnedResult = await ProjectHelper.getAllProjectsDataV2(
            user.companies,
            projectId,
            search,
            showArchived,
            role,
            filterTags,
            pinCandidateIds,
            1,
            pinCandidateIds.length,
            0,
            user._id,
            query.dateRange,
            listSort,
          );
          pinnedProjects = orderPinnedFirst(
            Array.isArray(pinnedResult)
              ? pinnedResult
              : pinnedResult.projects || [],
            pinCandidateIds,
          );
        }
        const { unpinnedSkip, unpinnedLimit } = splitPage(
          pinnedProjects.length,
        );
        const pinnedSlice = pinnedProjects.slice(
          query.skips,
          query.skips + query.pageSize,
        );

        const projectsResult = canQuery
          ? await ProjectHelper.getAllProjectsDataV2(
              user.companies,
              projectId,
              search,
              showArchived,
              role,
              filterTags,
              filterProjectsId,
              query.page,
              // $limit rejects 0, so ask for one row and discard it below when the page is
              // filled entirely by pins. Keeps the totalCount from the same call.
              Math.max(1, unpinnedLimit),
              unpinnedSkip,
              user._id,
              query.dateRange,
              listSort,
              pinCandidateIds,
            )
          : {
              projects: [],
              page: query.page,
              pageSize: query.pageSize,
              totalCount: 0,
              totalPages: 0,
            };

        const unpinnedProjects = (
          Array.isArray(projectsResult)
            ? projectsResult
            : projectsResult.projects || []
        ).slice(0, unpinnedLimit);
        const projects = [...pinnedSlice, ...unpinnedProjects];

        const op = (
          await Promise.all(
            projects.map(async (p) => {
              let canJoin = companyIds.includes(p.companyId.toString());
              const notAllowed: string[] = [USER_ROLE.ADMIN];

              const [members, crews, comments, postsCount, recentPosts] =
                await Promise.all([
                  ProjectHelper.getProjectMembersCount(p._id),
                  CrewsHelper.getCrewsCount(p._id),
                  CommentHelper.getCommentsCountByProject(p._id),
                  PostsHelper.getProjectsPostCount(p.companyId, p._id),
                  PostsHelper.getRecentProjectFiles(p.companyId, p._id),
                ]);

              if (!p.isMember) {
                notAllowed.push(USER_ROLE.LIMITED);
                notAllowed.push(USER_ROLE.CREW);
              }
              if (notAllowed.includes(user?.companies?.[0]?.role)) {
                canJoin = false;
              }

              let canAccess = true;

              if (role === MEMBER_TYPE.GUEST) {
                const adminUser = await CompanyHelpers.getCompanyAdminId(
                  p.companyId,
                );
                const [subscriptionActive, companiesProjectId] =
                  await Promise.all([
                    adminUser?.userId
                      ? UserHelper.isAdminSubscriptionActive(adminUser.userId)
                      : false,
                    ProjectHelper.getCompanyProjects([p.companyId], true),
                  ]);
                if (!subscriptionActive) {
                  const allowedProjects = companiesProjectId
                    .slice(0, 10)
                    .map((c) => c.toString());
                  if (!allowedProjects.includes(p._id.toString())) {
                    canAccess = false;
                  }
                }
              } else if (!isSubscriptionActive) {
                const allowedProjects = companyProjects
                  .slice(0, 10)
                  .map((c) => c.toString());
                if (!allowedProjects.includes(p._id.toString())) {
                  canAccess = false;
                }
              }

              // pinnedAt is the CALLER's pin timestamp now; the projects collection no longer
              // carries the field.
              const pinnedAt = pinnedAtById[p._id.toString()] ?? null;

              if (req.isExternalRequest) {
                delete p.projectImage;
                delete p.companyId;
                return {
                  ...p,
                  pinnedAt,
                  recentPosts: p?.recentPosts?.flat().slice(0, 5),
                };
              }
              return {
                ...p,
                pinnedAt,
                members,
                crews,
                comments,
                recentPosts,
                isMember: myProjectIds.includes(p._id.toString()),
                isGuest: role === MEMBER_TYPE.GUEST,
                posts: postsCount,
                createdAt: convertTime(p.createdAt),
                allowComment: myProjectIds.includes(p._id.toString()),
                canJoin,
                canAccess,
              };
            }),
          )
        ).filter(Boolean);

        if (
          !Array.isArray(projectsResult) &&
          typeof projectsResult === "object" &&
          "page" in projectsResult
        ) {
          // Pinned rows are excluded from the paged query, so the merged total is the sum.
          const totalCount = projectsResult.totalCount + pinnedProjects.length;
          return {
            rows: op,
            pagination: {
              page: projectsResult.page,
              pageSize: query.pageSize,
              totalCount,
              totalPages: Math.ceil(totalCount / query.pageSize),
            },
          };
        }
        return null;
      };

      // ES path: counts from the index (no per-row fan-out) + batched scalar/recentPosts supplements. GUEST + external requests stay on Mongo (irreducible per-row work + builder tenant-scope gap), so esCall === mongoCall for them. The input (incl. JSON.parse(filterTags)) is built lazily here so it never runs on the Mongo/GUEST/external/flag-off paths. Mirrors the Mongo path: role + filterUsers are pre-resolved into filterProjectsId above (so they're NOT passed to the builder — no double-restrict); dateRange remapped to { gte, lte }; showArchived → boolean.
      const esFn = async (): Promise<ProjectListPathResult> => {
        if (isRestrictedRole && !filterProjectsId.length) {
          return {
            rows: [],
            pagination: {
              page: query.page,
              pageSize: query.pageSize,
              totalCount: 0,
              totalPages: 0,
            },
          };
        }
        const input: ProjectListQueryInput = {
          companyId: user.companies[0].companyId,
          projectId: projectId ? ObjectId(projectId) : undefined,
          page: query.page,
          pageSize: query.pageSize,
          search: search && search.trim() ? search.trim() : undefined,
          showArchived: showArchived === "true",
          filterTags: filterTags
            ? JSON.parse(filterTags).map((t) => ObjectId(t))
            : undefined,
          dateRange: query.dateRange
            ? { gte: query.dateRange.startDate, lte: query.dateRange.endDate }
            : undefined,
          filterProjectsId: filterProjectsId.length
            ? filterProjectsId
            : undefined,
          sortBy: listSort.sortBy,
          sortOrder: listSort.sortOrder,
          userId: user._id,
        };

        // Pinned hits first, through the SAME filter set (ids-restricted to the pins, so this is
        // a trivial search), then reordered to pin order. Two searches, but the expensive batched
        // supplements still run ONCE inside getAllProjectsDataV2FromES over the merged hits.
        let pinnedHits: EsHit[] = [];
        if (pinCandidateIds.length) {
          const pinnedResult = await ProjectHelper.fetchProjectListHits({
            ...input,
            filterProjectsId: pinCandidateIds,
            from: 0,
            size: pinCandidateIds.length,
          });
          pinnedHits = orderPinnedFirst(pinnedResult.hits, pinCandidateIds);
        }
        const { unpinnedSkip, unpinnedLimit } = splitPage(pinnedHits.length);

        return ProjectHelper.getAllProjectsDataV2FromES(
          {
            ...input,
            excludeProjectIds: pinCandidateIds.length
              ? pinCandidateIds
              : undefined,
            from: unpinnedSkip,
            size: unpinnedLimit,
          },
          {
            companyProjects,
            isSubscriptionActive,
            companyIds,
            userCompanyRole: user?.companies?.[0]?.role,
            preHits: pinnedHits.slice(
              query.skips,
              query.skips + query.pageSize,
            ),
            extraTotal: pinnedHits.length,
            pinnedAtById,
          },
        );
      };

      const esCall =
        role === MEMBER_TYPE.GUEST || req.isExternalRequest ? mongoCall : esFn;

      const result = await searchWithFallback(
        "projects.list",
        user.companies[0].companyId,
        esCall,
        mongoCall,
        // Parity harness — undefined on every production request.
        {
          forcePath: (req as { parityForcePath?: "es" | "mongo" })
            .parityForcePath,
        },
      );

      if (result) {
        return SuccessResponse(res, status.OK, {
          data: {
            data: result.rows,
            pagination: result.pagination,
          },
        });
      }
    } catch (error) {
      next(error);
    }
  };

  public static getProjectDetails = async (
    req: AuthenticatedRequest & {
      query: { projectId: string; search: string };
    },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      let user, companies;
      if (req.headers?.authorization) {
        try {
          let authorizationHeader = req.headers.authorization;
          if (authorizationHeader.includes("Bearer")) {
            authorizationHeader = authorizationHeader.split(" ")[1];
          }
          const decoded = await verifyToken(authorizationHeader);

          user = await UserHelper.findOne(ObjectId(decoded.data._id));
          companies = await CompanyHelpers.getMyCompanies(user._id);
        } catch (er) {
          /* empty */
        }
      }
      const { projectId } = req.query;

      if (!projectId || !isValidObjectId(projectId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values",
        });
      }

      const project = await ProjectHelper.getProjectData(projectId);

      if (!project) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project not found",
        });
      }

      const [projects, myProjectIds, accessProject] = await Promise.all([
        ProjectHelper.getProjectDetails(projectId, project?.companyId),
        ProjectHelper.getMyProjectsArray(user?._id),
        ProjectHelper.getUserProjectData({
          projectId,
          userId: user?._id,
        }),
      ]);

      let companyIds = [];
      if (companies) {
        companyIds = companies.map((c) => c.companyId.toString());
      }

      const op = [];

      // Pin state on the detail view is the CALLER's, so it is null for unauthenticated
      // (public share link) requests. The isValidObjectId guard matters: this route accepts an
      // unvalidated query param, and getProjectDetails answers an invalid id with [] rather
      // than throwing — casting it here unguarded would turn that into a 500.
      const detailPinnedAt =
        user?._id && projects.length && isValidObjectId(projectId)
          ? await ProjectPinHelper.isPinned(user._id, ObjectId(projectId))
          : null;

      for (const p of projects) {
        let canJoin = companyIds.includes(p.companyId.toString());
        const notAllowed: string[] = [USER_ROLE.ADMIN];
        const isMember = myProjectIds.includes(p._id.toString());
        if (!isMember) {
          notAllowed.push(USER_ROLE.LIMITED);
          notAllowed.push(USER_ROLE.CREW);
        }
        if (notAllowed.includes(user?.companies?.[0]?.role)) {
          canJoin = false;
        }

        let canPush = true;
        const pushhable: string[] = [USER_ROLE.LIMITED, USER_ROLE.CREW];
        if (pushhable.includes(user?.companies?.[0]?.role) && !isMember) {
          canPush = false;
        }

        let isGuest = false;

        if (accessProject && accessProject.type == MEMBER_TYPE.GUEST) {
          isGuest = true;
        }

        if (canPush) {
          if (req.isExternalRequest) {
            delete p.projectImage;
            delete p.companyId;
            op.push({ ...p, pinnedAt: detailPinnedAt });
          } else {
            op.push({
              ...p,
              pinnedAt: detailPinnedAt,
              createdAt: convertTime(p.createdAt),
              allowComment: myProjectIds.includes(p._id.toString()),
              isMember,
              canJoin,
              isGuest,
            });
          }
        }
      }

      return SuccessResponse(res, status.OK, {
        data: op,
      });
    } catch (error) {
      next(error);
    }
  };

  public static join = async (
    req: AuthenticatedRequest & { query: { userId: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const user: UserType = req.user;
      const { projectId } = req.query;
      const project = await ProjectHelper.getCompanyId(projectId);
      const company = user.companies.filter(
        (c) => c.companyId.toString() == project.companyId.toString(),
      )[0];

      if (company.role == USER_ROLE.LIMITED || company.role == USER_ROLE.CREW) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "your are not authorized to join",
        });
      }

      if (req.query.userId) {
        if (
          isValidObjectId(req.query.userId) &&
          isStandardAndAbove(company.role)
        ) {
          await ProjectHelper.joinProject(
            req.query.userId,
            projectId,
            USER_ROLE.STANDARD,
          );
          this.invokeNotications(projectId, req.query.userId, user);
        } else {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "your are not authorized to join",
          });
        }
      } else {
        await ProjectHelper.joinProject(user._id, projectId, company.role);
      }

      return SuccessResponse(res, status.OK, {
        message: "joined successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static leave = async (
    req: AuthenticatedRequest & { query: { userId: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const { projectId } = req.query;
      const project = await ProjectHelper.getCompanyId(projectId);
      const projectAccess = await ProjectHelper.getUserProjectData({
        projectId,
        userId: req.query.userId || req.user._id,
      });

      const company = req.user.companies.filter(
        (c) => c.companyId.toString() == project.companyId.toString(),
      )[0];

      if (req.query.userId) {
        const userAccess = await CompanyHelpers.getMyCompanies(
          req.query.userId,
        );
        if (userAccess?.[0]) {
          if (
            projectAccess &&
            projectAccess.type != MEMBER_TYPE.GUEST &&
            userAccess[0].role == USER_ROLE.ADMIN
          ) {
            return ErrorResponse(res, status.BAD_REQUEST, {
              message: "your are not authorized to leave",
            });
          }
          if (
            isValidObjectId(req.query.userId) &&
            isStandardAndAbove(company.role)
          ) {
            await ProjectHelper.leaveProject(req.query.userId, projectId);
          } else {
            return ErrorResponse(res, status.BAD_REQUEST, {
              message: "your are not authorized to leave",
            });
          }
        }
      } else {
        if (
          projectAccess &&
          (projectAccess.type != MEMBER_TYPE.GUEST ||
            (company && company.role == USER_ROLE.ADMIN))
        ) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "your are not authorized to leave",
          });
        }
        await ProjectHelper.leaveProject(req.user._id, projectId);
      }

      return SuccessResponse(res, status.OK, {
        message: "left successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getMembers = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      let data = await ProjectHelper.getProjectMembers(req.query.projectId);

      if (req.isExternalRequest) {
        data = data.map((d) => {
          delete d.type;
          return { ...d };
        });
      }
      return SuccessResponse(res, status.OK, {
        data,
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
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { projectId } = req.body;

      const projectData = await ProjectHelper.getProjectData(projectId);

      const [projectMembers, adminUser, accessProject] = await Promise.all([
        ProjectHelper.getProjectMembers(projectId),
        CompanyHelpers.getCompanyAdminId(projectData.companyId),
        ProjectHelper.getUserProjectData({
          projectId,
          userId: req.user._id,
        }),
      ]);

      if (accessProject && accessProject.type == MEMBER_TYPE.GUEST) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "your are not authorized to update",
        });
      }

      await ProjectHelper.put(req.body);

      const projectMemberIds = projectMembers.map((u) => u._id.toString());
      let users = [];

      if (req?.body?.update?.addUsers?.length) {
        users = req.body.update.addUsers;
      }

      const createPostNotification = this.invokeNotications;

      if (users.length) {
        await Promise.all(
          projectMemberIds.map(async (userId) => {
            if (
              userId == adminUser?.userId?.toString() ||
              userId == req.user._id.toString()
            )
              return;
            else if (!users.includes(userId)) {
              ProjectHelper.leaveProject(userId, projectId);
            }
          }),
        );

        await Promise.all(
          users.map(async (userId) => {
            if (!projectMemberIds.includes(userId)) {
              ProjectHelper.addToProject(projectId, userId);
              createPostNotification(projectId, userId, req.user);
            }
          }),
        );
      }

      // Trigger CRM integration sync for project updates (async, non-blocking)
      onProjectUpdated(projectId).catch((err) => {
        console.error("Project update integration hook error:", err);
      });

      return SuccessResponse(res, status.OK, {
        message: "Project updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getUserData = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        userId: "string|required",
      });

      const matched = await validator.check();
      const user: UserType = req.user;

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const [userData, company, projects] = await ProjectHelper.user(
        req.query.userId,
        user.companyId,
      );

      const data: any = {
        ...userData,
        userName: userData.name.first + " " + userData.name.last,
        createdAt: convertTime(
          company?.createdAt || userData.lastActivity,
          true,
        ),
        role: company?.role || USER_ROLE.LIMITED,
      };

      if (
        user?.companies?.[0]?.role &&
        isStandardAndAbove(user.companies[0].role)
      ) {
        data.projects = projects;
      }

      if (data.role == USER_ROLE.ADMIN || !data?.role) {
        data.projects = [];
      }

      return SuccessResponse(res, status.OK, {
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static invokeNotications = async (projectId, userId, createdBy) => {
    const projectData = await ProjectHelper.getProjectData(projectId);

    const url = config.APP_URL + `/ProjectDetail?projectId=${projectId}`;

    const messageParams = {
      actor: createdBy.fullName,
      project: projectData.name,
    };

    const notications = [
      {
        userId,
        message: translate(NotificationMessageKey.PROJECT_ADDED, messageParams),
        messageKey: NotificationMessageKey.PROJECT_ADDED,
        messageParams,
        projectId,
        createdBy: createdBy._id,
        category: NotificationCategory.PROJECT_ADDED,
        url,
      },
    ];

    await NotificationsHelpers.createAndSendNotfications(
      notications,
      true,
      projectData.name,
    );
  };

  public static getTotalProjects = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await ProjectHelper.getCompanyProjects([req.user.companyId]);

      return SuccessResponse(res, status.OK, {
        data: data.length,
      });
    } catch (error) {
      next(error);
    }
  };

  // Dedicated read for the sidebar's "Pinned" rail. The rail only renders id + name, and
  // previously got them by pulling a 100-row page of /projects/list — whose Mongo path fans
  // five sub-queries out per row, so the rail alone could cost ~500 queries on every fresh
  // page load. This is two index-served reads. No request params: the response is entirely
  // determined by the caller's identity, so there is nothing to validate beyond auth.
  public static getPinned = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      instrumentBaselineLatency(res, "projects.pinned", () =>
        req.user?.companyId?.toString(),
      );

      const user: UserType = req.user;
      const companyId = user?.companies?.[0]?.companyId;
      if (!companyId) {
        // No active company means no pins are reachable — an empty rail, not an error.
        return SuccessResponse(res, status.OK, { data: [] });
      }

      const userRole = user?.companies?.[0]?.role;
      const isRestrictedRole =
        userRole === USER_ROLE.LIMITED || userRole === USER_ROLE.CREW;

      const data = await ProjectPinHelper.listPinnedSummaries(
        user._id,
        companyId,
        isRestrictedRole,
      );

      return SuccessResponse(res, status.OK, { data });
    } catch (error) {
      next(error);
    }
  };

  // Pins are per-user (projectpins collection), not a field on the project — pinning never
  // mutates the project document, so it emits no change-stream event and no reindex.
  public static pin = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { projectId } = req.body;
      if (!projectId || !isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "a valid projectId is required",
        });
      }
      const companyId = req.user.companyId;
      if (!companyId) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "no active company for this user",
        });
      }
      const projectObjectId = ObjectId(projectId);
      const inCompany = await ProjectPinHelper.assertProjectInCompany(
        projectObjectId,
        companyId,
      );
      if (!inCompany) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "project not found",
        });
      }

      // Cap check before the upsert. countDocuments-then-upsert is racy under concurrent pins,
      // so two simultaneous requests can land a 21st row; the cap is a soft UX limit and the
      // read path re-clamps with .limit(MAX_PINS_PER_USER), so that's tolerated rather than
      // paying for a transaction. Re-pinning an existing pin skips the cap entirely.
      const alreadyPinned = await ProjectPinHelper.isPinned(
        req.user._id,
        projectObjectId,
      );
      if (!alreadyPinned) {
        const pinCount = await ProjectPinHelper.countForUser(
          req.user._id,
          companyId,
        );
        if (pinCount >= MAX_PINS_PER_USER) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `You can pin up to ${MAX_PINS_PER_USER} projects. Unpin one to make room.`,
          });
        }
      }

      await ProjectPinHelper.pin(req.user._id, companyId, projectObjectId);
      return SuccessResponse(res, status.OK, {
        message: "project pinned successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static unpin = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { projectId } = req.body;
      if (!projectId || !isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "a valid projectId is required",
        });
      }
      // No company/tenant check needed: the delete is scoped to the caller's own pin row, so
      // the worst case is a no-op delete of something they never owned.
      await ProjectPinHelper.unpin(req.user._id, ObjectId(projectId));
      return SuccessResponse(res, status.OK, {
        message: "project unpinned successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  // Team-wide pin: fans the pin out to every ACTIVE non-GUEST member of the project. Writes into
  // other users' accounts, so the route is gated to admins/managers (see index.ts) on top of the
  // company scope check below. Members already at MAX_PINS_PER_USER are skipped and reported
  // rather than pushed over the cap.
  public static pinForAll = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { projectId } = req.body;
      if (!projectId || !isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "a valid projectId is required",
        });
      }
      const companyId = req.user.companyId;
      if (!companyId) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "no active company for this user",
        });
      }
      const projectObjectId = ObjectId(projectId);
      const inCompany = await ProjectPinHelper.assertProjectInCompany(
        projectObjectId,
        companyId,
      );
      if (!inCompany) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "project not found",
        });
      }

      const memberIds =
        await ProjectPinHelper.listPinnableMemberIds(projectObjectId);
      const result = await ProjectPinHelper.pinForUsers(
        memberIds,
        companyId,
        projectObjectId,
      );

      return SuccessResponse(res, status.OK, {
        message: result.skippedAtCap
          ? `project pinned for ${result.pinnedFor} member(s); ${result.skippedAtCap} skipped (already at ${MAX_PINS_PER_USER} pins)`
          : "project pinned for all members successfully",
        data: {
          totalMembers: memberIds.length,
          ...result,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  // Undo for pinForAll — clears this project's pin for EVERY user, including members who had
  // pinned it themselves. Same admin/manager gate.
  //
  // No client calls this yet, deliberately: "Unpin for Team" was decided against as a UI
  // action. Kept as the manual remedy for a mis-clicked team pin (an admin or support can
  // call it directly), since the alternative is asking every member to unpin by hand.
  public static unpinForAll = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { projectId } = req.body;
      if (!projectId || !isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "a valid projectId is required",
        });
      }
      const companyId = req.user.companyId;
      if (!companyId) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "no active company for this user",
        });
      }
      const projectObjectId = ObjectId(projectId);
      // Tenant check matters more here than on the self-unpin: this deletes other users' rows,
      // so a cross-company projectId must not be actionable.
      const inCompany = await ProjectPinHelper.assertProjectInCompany(
        projectObjectId,
        companyId,
      );
      if (!inCompany) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "project not found",
        });
      }

      const cleared = await ProjectPinHelper.unpinForAll(projectObjectId);
      return SuccessResponse(res, status.OK, {
        message: "project unpinned for all members successfully",
        data: { cleared },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /projects/delete — move a project and all of its content to the bin.
   *
   * Admin/manager only and company-scoped, matching the merge guard: this is the
   * most destructive project operation we expose, and the scoping also stops a
   * multi-company user from binning another tenant's project.
   */
  public static softDelete = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectId: "required|string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { projectId } = req.body;
      if (!isValidObjectId(projectId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid projectId",
        });
      }

      const project = await ProjectHelper.getProjectForDelete(
        ObjectId(projectId),
      );
      if (!project) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project not found",
        });
      }

      const managedCompanyIds = getActiveAdminCompanies(
        req.user?.companies,
      ).map((companyId) => companyId.toString());

      if (!managedCompanyIds.includes(project.companyId?.toString())) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "you are not authorized to delete this project",
        });
      }

      if (project.status === CURRENT_STATUS.DELETED) {
        return ErrorResponse(res, status.CONFLICT, {
          message: "this project is already in the bin",
        });
      }

      const deleted = await ProjectService.softDeleteProject(
        ObjectId(projectId),
      );

      return SuccessResponse(res, status.OK, {
        message: `project moved to bin, it will be permanently deleted after ${TRASHBIN_NO_OF_DAYS} days`,
        data: { projectId, deleted },
      });
    } catch (error) {
      next(error);
    }
  };

  public static archive = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { projectId } = req.body;
      await ProjectHelper.put({
        projectId,
        update: { archivedAt: new Date() },
      });

      // Trigger CRM integration sync for project updates (async, non-blocking)
      onProjectUpdated(projectId).catch((err) => {
        console.error("Project update integration hook error:", err);
      });

      return SuccessResponse(res, status.OK, {
        message: "project archived successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static unarchive = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { projectId } = req.body;
      await ProjectHelper.unset({
        projectId,
        fields: { archivedAt: "" },
      });

      // Trigger CRM integration sync for project updates (async, non-blocking)
      onProjectUpdated(projectId).catch((err) => {
        console.error("Project update integration hook error:", err);
      });

      return SuccessResponse(res, status.OK, {
        message: "project unarchive successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getPeople = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userRole = req.user.roles;
      const validator = new Validator(req.query, {
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { projectId } = req.query;

      const projectData = await ProjectHelper.getProjectData(projectId);

      if (!projectData) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Project not found",
        });
      }

      const [people, members] = await Promise.all([
        ProjectHelper.getpeople(projectData.companyId),
        ProjectHelper.getProjectMembers(projectId),
      ]);

      const accessProject = await ProjectHelper.getUserProjectData({
        projectId,
        userId: req.user._id,
      });

      const shouldShowLastActivity =
        userRole === USER_ROLE.ADMIN || userRole === USER_ROLE.MANAGER;

      const guestMembers = members
        .filter((member) => member.type == MEMBER_TYPE.GUEST)
        .map((member) => {
          const memberData: any = {
            ...member,
            userRole: `Guest`,
            roles: MEMBER_TYPE.GUEST,
            isMember: true,
          };
          // Only include lastActivity if current user is ADMIN or MANAGER
          if (shouldShowLastActivity && member.lastActivity) {
            memberData.lastActivity = member.lastActivity;
          } else {
            memberData.lastActivity = "";
          }
          return memberData;
        });

      const memberIds = members.map((member) => member._id.toString());

      const allMembers = [
        ...guestMembers,
        ...people.map((member) => {
          const memberData: any = {
            ...member,
            isMember: memberIds.includes(member._id.toString()),
          };
          // Only include lastActivity if current user is ADMIN or MANAGER
          if (shouldShowLastActivity && member.lastActivity) {
            memberData.lastActivity = member.lastActivity;
          } else {
            memberData.lastActivity = "";
          }
          return memberData;
        }),
      ];

      const data =
        accessProject && accessProject.type != MEMBER_TYPE.GUEST
          ? allMembers.sort((a, b) => {
              return b.isMember - a.isMember;
            })
          : allMembers.filter((member) => member.isMember);

      return SuccessResponse(res, status.OK, {
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getSearchResults = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const user: UserType = req.user;
      const query = req.query;
      const { projectId, postId } = query;
      const search = postId || "";

      if (query?.dateRange) {
        query.dateRange = JSON.parse(query.dateRange);
        query.dateRange.startDate = getDayStart(query.dateRange.startDate);
        query.dateRange.endDate = getDayEnd(query.dateRange.endDate);
      }

      // Uploads counts run through the uploads match (files), NOT the post feed,
      // so they land in the same unit as the Uploads badge from /tab-counts.
      const uploadsUser: UploadsScopeUser = {
        userId: user._id,
        role: user?.companies?.[0]?.role,
        companyIds: user?.companies?.map((c) => c.companyId) ?? [],
      };
      const uploadsQuery = {
        ...req.query,
        projectId,
      } as unknown as PaginatedSearchQuery & MyUploadsQuery;

      const [uploads, checklists, reports, tasks, files] = await Promise.all([
        PostsHelper.countUploadFiles(
          { ...uploadsQuery, userId: "" },
          uploadsUser,
        ),
        // findAllChecklist applies no status filter of its own ($match: query),
        // so the DELETED exclusion has to be passed in — same as the checklist
        // list route does. Without it this count saw deleted rows that
        // ChecklistHelper.countByProject (the badge total) excludes, so the
        // Checklists pill rendered impossibilities like "5 of 3".
        ChecklistHelper.findAllChecklist({
          type: CHECKLIST_TYPE.CHECKLIST,
          status: { $ne: CHECKLIST_STATUS.DELETED },
          projectId: ObjectId(projectId),
          // Escaped and capped to match the checklist LIST route exactly. Raw,
          // this counted "abc" for a search of "a.c" while the badge total
          // (escaped) counted only a literal "a.c" — matched > total, the same
          // "5 of 3" the missing DELETED filter produced. An unbalanced pattern
          // like "(" is also rejected by Mongo, 500ing every tab's count at once.
          name: {
            $regex: escapeRegExp(String(search).slice(0, SEARCH_MAX_LENGTH)),
            $options: "i",
          },
        }),
        ProjectReportsHelpers.getList({
          projectId,
          search,
        }),
        ProjectTasksHelper.findAll({
          projectId,
          search,
        }),
        FilesHelper.getFilesByProject(
          user.companyId,
          ObjectId(projectId),
          user._id,
          user?.companies?.[0]?.role as USER_ROLE,
          search,
        ),
      ]);
      // These counts drive the per-tab "has matches" dots and match pills. The
      // uploads number is MATCHING FILES — the same unit as the Uploads badge
      // (getProjectPhotoCount) and as UploadsPage.totalFiles — so it can be
      // rendered as an uploads count directly.
      return SuccessResponse(res, status.OK, {
        data: {
          [ProjectDetailTab.UPLOADS]: uploads,
          [ProjectDetailTab.CHECKLIST]: search ? checklists.length : 0,
          [ProjectDetailTab.REPORTS]: search ? reports.length : 0,
          [ProjectDetailTab.TASKS]: search ? tasks.length : 0,
          [ProjectDetailTab.FILES]: search ? files.length : 0,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static getImagesPdf = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        projectId: "required|string",
        selectedImages: `required|array|length:${PRINT_PHOTO_CAP},1`,
        "selectedImages.*.fileId": "required|string",
        photosPerPage: `integer|in:${PHOTOS_PER_PAGE_OPTIONS.join(",")}`,
        includeFileDetails: "boolean",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const {
        projectId,
        selectedImages,
        photosPerPage = DEFAULT_PHOTOS_PER_PAGE,
        includeFileDetails = false,
      } = req.body as {
        projectId: string;
        selectedImages: { fileId: string }[];
        photosPerPage?: number;
        includeFileDetails?: boolean | string | number;
      };

      // The validator also accepts string booleans and numeric 0/1 values.
      const showFileDetails =
        includeFileDetails === true ||
        includeFileDetails === "true" ||
        includeFileDetails === 1 ||
        includeFileDetails === "1";

      const hasInvalidId =
        !isValidObjectId(projectId) ||
        selectedImages.some(({ fileId }) => !isValidObjectId(fileId));

      if (hasInvalidId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid file or project ID",
        });
      }

      const fileIds = selectedImages.map(({ fileId }) => ObjectId(fileId));
      // Scoped to the caller's company and the project the photos were selected
      // from, so file IDs from another tenant or project can't be exported.
      const files = await ProjectHelper.getPostFiles(
        fileIds,
        req.user.companyId,
        ObjectId(projectId),
      );

      if (!files.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "No images found",
        });
      }

      // $in returns documents in storage order; restore the order the client
      // selected the photos in.
      const filesById = new Map(
        files.map((file) => [String(file._id), file] as const),
      );
      const imageData = fileIds
        .map((id) => filesById.get(String(id)))
        .filter((file): file is IImagesPdfFile => Boolean(file));

      const projectAddress = showFileDetails
        ? await ProjectHelper.getProjectPrintAddress(
            ObjectId(projectId),
            req.user.companyId,
          )
        : undefined;

      const pdfBuffer = await PDFService.generateImagesPdfFromData({
        imageData,
        photosPerPage: Number(photosPerPage),
        includeFileDetails: showFileDetails,
        projectAddress,
      });

      if (!pdfBuffer || pdfBuffer.length === 0) {
        throw new Error("PDF generation returned empty buffer");
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="photos-${Date.now()}.pdf"`,
      );
      res.setHeader("Content-Length", pdfBuffer.length.toString());
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      return res.status(status.OK).end(pdfBuffer, "binary");
    } catch (error) {
      next(error);
    }
  };

  // Loads both sides of a merge and runs every guard shared by the preview and the
  // merge itself: id validity, tenant scope (the caller must hold a project-managing
  // role in the projects' company), and prior-merge state.
  private static resolveMergeSides = async (
    user: UserType,
    sourceProjectId: string,
    destinationProjectId: string,
  ): Promise<
    | { error: { statusCode: number; message: string } }
    | { source: IMergeProjectDoc; destination: IMergeProjectDoc }
  > => {
    if (
      !isValidObjectId(sourceProjectId) ||
      !isValidObjectId(destinationProjectId)
    ) {
      return {
        error: { statusCode: status.BAD_REQUEST, message: "Invalid projectId" },
      };
    }

    if (sourceProjectId === destinationProjectId) {
      return {
        error: {
          statusCode: status.BAD_REQUEST,
          message: "a project cannot be merged into itself",
        },
      };
    }

    const [source, destination] = await Promise.all([
      ProjectMergeHelper.getProjectForMerge(ObjectId(sourceProjectId)),
      ProjectMergeHelper.getProjectForMerge(ObjectId(destinationProjectId)),
    ]);

    if (!source || !destination) {
      return {
        error: { statusCode: status.NOT_FOUND, message: "Project not found" },
      };
    }

    // Only companies where this user is an admin/manager (PROJECT_ACCESS), which
    // also keeps a multi-company user from merging across tenants.
    const managedCompanyIds = getActiveAdminCompanies(user?.companies).map(
      (companyId) => companyId.toString(),
    );

    if (
      !managedCompanyIds.includes(source.companyId?.toString()) ||
      !managedCompanyIds.includes(destination.companyId?.toString())
    ) {
      return {
        error: {
          statusCode: status.FORBIDDEN,
          message: "you are not authorized to merge these projects",
        },
      };
    }

    if (source.companyId?.toString() !== destination.companyId?.toString()) {
      return {
        error: {
          statusCode: status.BAD_REQUEST,
          message: "projects from different companies cannot be merged",
        },
      };
    }

    if (source.mergedInto) {
      return {
        error: {
          statusCode: status.CONFLICT,
          message: "this project has already been merged into another project",
        },
      };
    }

    if (destination.mergedInto) {
      return {
        error: {
          statusCode: status.BAD_REQUEST,
          message:
            "the destination project has already been merged into another project",
        },
      };
    }

    if (destination.archivedAt) {
      return {
        error: {
          statusCode: status.BAD_REQUEST,
          message: "an archived project cannot be used as the destination",
        },
      };
    }

    return { source, destination };
  };

  // Review step for a merge: which project is kept, which is archived, the field
  // values that disagree, and how much content will move.
  public static mergePreview = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        sourceProjectId: "required|string",
        destinationProjectId: "required|string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { sourceProjectId, destinationProjectId } = req.query as {
        sourceProjectId: string;
        destinationProjectId: string;
      };

      const sides = await this.resolveMergeSides(
        req.user,
        sourceProjectId,
        destinationProjectId,
      );

      if ("error" in sides) {
        return ErrorResponse(res, sides.error.statusCode, {
          message: sides.error.message,
        });
      }

      const preview = await ProjectMergeHelper.buildPreview(
        sides.source,
        sides.destination,
      );

      return SuccessResponse(res, status.OK, { data: preview });
    } catch (error) {
      next(error);
    }
  };

  public static merge = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        sourceProjectId: "required|string",
        destinationProjectId: "required|string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { sourceProjectId, destinationProjectId } = req.body as {
        sourceProjectId: string;
        destinationProjectId: string;
      };
      const resolutions: IProjectMergeResolutions = req.body?.resolutions ?? {};

      const invalidResolutions = Object.entries(resolutions).filter(
        ([field, choice]) =>
          !MERGE_CONFLICT_FIELDS.includes(field as MERGE_CONFLICT_FIELD) ||
          !MERGE_FIELD_CHOICES.includes(choice),
      );

      if (invalidResolutions.length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `invalid merge resolutions: ${invalidResolutions
            .map(([field]) => field)
            .join(", ")}`,
        });
      }

      const sides = await this.resolveMergeSides(
        req.user,
        sourceProjectId,
        destinationProjectId,
      );

      if ("error" in sides) {
        return ErrorResponse(res, sides.error.statusCode, {
          message: sides.error.message,
        });
      }

      const { conflicts } = ProjectMergeHelper.getFieldDiff(
        sides.source,
        sides.destination,
      );
      const unresolved = ProjectMergeHelper.getUnresolvedConflicts(
        conflicts,
        resolutions,
      );

      if (unresolved.length) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `choose which value to keep for: ${unresolved.join(", ")}`,
          errors: { unresolvedConflicts: unresolved, conflicts },
        });
      }

      const result = await ProjectMergeHelper.execute({
        source: sides.source,
        destination: sides.destination,
        resolutions,
        userId: req.user._id,
      });

      // Posts/files moving between projects don't touch either project document, so the
      // search index's denormalized counts need an explicit re-derivation for both sides.
      Promise.all([
        reindexProjectById(result.destinationProjectId),
        reindexProjectById(result.sourceProjectId),
      ]).catch((err) => {
        console.error("Project merge search reindex error:", err);
      });

      // Trigger CRM integration sync for both projects (async, non-blocking)
      onProjectUpdated(result.destinationProjectId).catch((err) => {
        console.error("Project update integration hook error:", err);
      });
      onProjectUpdated(result.sourceProjectId).catch((err) => {
        console.error("Project update integration hook error:", err);
      });

      return SuccessResponse(res, status.OK, {
        message: "projects merged successfully",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  // Per-tab content counts for the project-details tab badges. Each count is a
  // dedicated, index-backed countDocuments that mirrors the corresponding tab's
  // own list filter (see each helper's countByProject), so badges always match
  // what the user sees inside the tab. Files are role/company-scoped via
  // FilesHelper so STANDARD users never see a count that includes restricted
  // files. Runs authenticated (registered after authMiddleware).
  public static getTabCounts = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const user: UserType = req.user;
      const { projectId } = req.query;

      if (!projectId || !isValidObjectId(projectId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values",
        });
      }

      const role = user?.companies?.[0]?.role as USER_ROLE;

      const [uploads, files, tasks, checklists, reports, notes] =
        await Promise.all([
          PostsHelper.getProjectPhotoCount(projectId),
          FilesHelper.countByProject(
            user.companyId,
            ObjectId(projectId),
            user._id,
            role,
          ),
          ProjectTasksHelper.countByProject(projectId),
          ChecklistHelper.countByProject(projectId),
          // The Reports tab is now Documents, so its badge counts every
          // document type — not just manual reports, which left the badge
          // disagreeing with the list the moment the tab opened.
          ProjectDocumentHelpers.count({
            projectId: ObjectId(projectId),
            companyId: user.companyId,
            types: DOCUMENT_TYPES,
            authors: [],
            range: {},
          }),
          ProjectNotesHelper.countByProject(projectId),
        ]);

      return SuccessResponse(res, status.OK, {
        data: { uploads, files, tasks, checklists, reports, notes },
      });
    } catch (error) {
      next(error);
    }
  };
}
