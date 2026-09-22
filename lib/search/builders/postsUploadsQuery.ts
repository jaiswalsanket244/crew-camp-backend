import { Search_Request } from "@opensearch-project/opensearch/api";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import { SORT_TYPE } from "../../utils/enums/post";
import { PostsUploadsQueryInput, QueryClause } from "../types/queries";
import {
  companyScopeClause,
  rangeFilter,
  termFilter,
  termsFilter,
} from "./clauses";
import { paginationWindow } from "./pagination";

// Maps the shipped getUploads `sortBy` enum to the ES sort on the flat posts_uploads file docs. Parity gap: Mongo coalesces $ifNull(timestamp, createdAt) and groups files by post in default mode; this builder sorts flat file docs with `position` as the stable tiebreaker.
const sortFor = (sortBy?: SORT_TYPE): QueryClause[] => {
  switch (sortBy) {
    case SORT_TYPE.OLDEST:
      return [{ createdAt: "asc" }, { position: "asc" }];
    case SORT_TYPE.DATE_TAKEN_ASC:
      return [{ timestamp: "asc" }, { createdAt: "asc" }, { position: "asc" }];
    case SORT_TYPE.DATE_TAKEN_DESC:
      return [
        { timestamp: "desc" },
        { createdAt: "desc" },
        { position: "asc" },
      ];
    case SORT_TYPE.NEWEST:
    default:
      return [{ createdAt: "desc" }, { position: "asc" }];
  }
};

// Translates the shipped getUploads feed (backed by postFiles) into an OpenSearch query against the `posts_uploads` alias. Pure: builds DSL, never executes. Every query is tenant-scoped (companyScopeClause first), routed by companyId, and gated to ACTIVE status (the index stores soft-deleted files too).
export const buildPostsUploadsQuery = (
  input: PostsUploadsQueryInput,
): Search_Request => {
  // Project scope: filterProjects (multi) takes precedence over single projectId, matching the handler; appended AFTER companyScopeClause + status, never alone.
  const projectClause = input.filterProjects?.length
    ? termsFilter(
        "projectId",
        input.filterProjects.map((p) => p.toString()),
      )
    : input.projectId
      ? termFilter("projectId", input.projectId.toString())
      : undefined;

  // Uploader scope: filterUsers (multi) takes precedence over single userId.
  const uploaderClause = input.filterUsers?.length
    ? termsFilter(
        "userId",
        input.filterUsers.map((u) => u.toString()),
      )
    : input.userId
      ? termFilter("userId", input.userId.toString())
      : undefined;

  const filter = [
    companyScopeClause(input.companyId), // ALWAYS first; throws if companyId missing
    termFilter("status", CURRENT_STATUS.ACTIVE), // ALWAYS — index stores soft-deleted files too
    projectClause,
    uploaderClause,
    input.filterTags?.length &&
      termsFilter(
        "tags",
        input.filterTags.map((t) => t.toString()),
      ),
    // fileType is index-provisioned but not used by the current shipped feed — emitted only when a caller opts in, so parity holds when omitted.
    input.fileType && termFilter("fileType", input.fileType),
    input.dateRange &&
      (input.dateRange.gte != null || input.dateRange.lte != null) &&
      rangeFilter("createdAt", input.dateRange),
  ].filter(Boolean) as QueryClause[];

  // Token match (relevance) OR phrase-prefix on the denormalized `note` for as-you-type — closes the type-ahead half of the Mongo substring-regex gap; mid-word substrings would need an edge-ngram reindex.
  const bool: QueryClause = { filter };
  if (input.search) {
    bool.must = [
      {
        bool: {
          should: [
            { match: { note: input.search } },
            { match_phrase_prefix: { note: input.search } },
          ],
          minimum_should_match: 1,
        },
      },
    ];
  }

  // Clamp from/size to the ES max_result_window so a deep page mirrors Mongo's empty page instead of throwing "Result window is too large".
  const { from, size } = paginationWindow(input.page, input.pageSize);
  const request: QueryClause = {
    index: "posts_uploads", // alias, never the versioned concrete index
    routing: input.companyId.toString(), // shard routing
    body: {
      query: { bool },
      from,
      size,
      sort: sortFor(input.sortBy),
      track_total_hits: true, // accurate totalCount (ES default caps at 10000)
    },
  };

  // The clause helpers emit the project's structural `QueryClause`, which does not satisfy OpenSearch's exact DSL types; assert at this boundary (not `any` — request shape is verified by unit tests).
  return request as unknown as Search_Request;
};
