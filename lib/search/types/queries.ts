// Read-path query types.
import { MEMBER_TYPE, USER_ROLE } from "../../utils/enums/enums";
import { SORT_TYPE } from "../../utils/enums/post";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";

// A single OpenSearch bool-query leaf clause (term/terms/range/match/match_all/…); the builders compose these into bool.filter / bool.must arrays.
export type QueryClause = Record<string, unknown>;

// A parsed date-range filter input consumed by rangeFilter.
export interface ParsedDateRange {
  gte?: Date | string | number;
  lte?: Date | string | number;
}

// Input for buildProjectListQuery — mirrors the shipped getAllProjectsDataV2 handler's effective inputs. companyId is MANDATORY (tenant chokepoint). companyId/userId/role(LIMITED|CREW) MUST be sourced from req.user by the handler, never req.query.
export interface ProjectListQueryInput {
  companyId: ObjectIdType; // MANDATORY — tenant isolation chokepoint
  userId?: ObjectIdType; // for roleVisibilityClause (restricted roles)
  search?: string; // full-text over name/description/location
  filterTags?: ObjectIdType[];
  filterUsers?: ObjectIdType[]; // → members membership filter
  dateRange?: ParsedDateRange; // applied to createdAt (handler remaps {startDate,endDate})
  role?: MEMBER_TYPE | USER_ROLE;
  showArchived?: boolean; // true → only archived; else → only non-archived
  projectId?: ObjectIdType; // single-project lookup — precedence over filterProjectsId (mirrors Mongo _id match)
  filterProjectsId?: ObjectIdType[]; // → _id terms (handler-computed)
  excludeProjectIds?: ObjectIdType[]; // → must_not ids; the caller's pinned rows, spliced in by the handler
  from?: number; // explicit window override (pinned-row splice shifts the unpinned offset); falls back to page/pageSize
  size?: number; // explicit window override; falls back to page/pageSize
  sortBy?: "name" | "createdAt" | "updatedAt"; // handler-validated; default updatedAt (name → name.keyword)
  sortOrder?: "asc" | "desc"; // default: name → asc, dates → desc (handler resolves before passing)
  page: number; // 1-indexed
  pageSize: number;
}

// Input for buildPostsUploadsQuery — mirrors the shipped getUploads feed (backed by postFiles). companyId is MANDATORY (tenant chokepoint). The handler maps req.query (postId→search, filterPostTags→filterTags, limit→pageSize, lastMonth→dateRange, filterProjectTags→filterProjects) and sources companyId from the decoded token.
export interface PostsUploadsQueryInput {
  companyId: ObjectIdType; // MANDATORY — tenant isolation chokepoint
  projectId?: ObjectIdType; // single project (defense-in-depth, after companyScope)
  filterProjects?: ObjectIdType[]; // multi-project → projectId terms (precedence over projectId)
  userId?: ObjectIdType; // single uploader
  filterUsers?: ObjectIdType[]; // multi-uploader → userId terms (precedence over userId)
  filterTags?: ObjectIdType[]; // → tags terms (from filterPostTags)
  fileType?: string; // index-provisioned; not wired in the current shipped feed
  search?: string; // → match on the denormalized note field
  dateRange?: ParsedDateRange; // applied to createdAt (handler remaps {startDate,endDate})
  sortBy?: SORT_TYPE; // NEWEST (default) / oldest / dateTakenAsc / dateTakenDesc
  page: number; // 1-indexed
  pageSize: number;
}
