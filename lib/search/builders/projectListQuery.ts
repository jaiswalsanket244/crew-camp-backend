import { Search_Request } from "@opensearch-project/opensearch/api";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import { ProjectListQueryInput, QueryClause } from "../types/queries";
import {
  companyScopeClause,
  rangeFilter,
  roleVisibilityClause,
  termFilter,
  termsFilter,
} from "./clauses";
import { clampWindow, paginationWindow } from "./pagination";

// Translates the shipped getAllProjectsDataV2 input shape into an OpenSearch query against the `projects` alias. Pure: builds DSL, never executes. Every query is tenant-scoped (companyScopeClause first), routed by companyId, and gated to ACTIVE status (the index stores all statuses).
export const buildProjectListQuery = (
  input: ProjectListQueryInput,
): Search_Request => {
  // Only include a role-visibility clause when it actually restricts; roleVisibilityClause returns a no-op { match_all: {} } for unrestricted roles (or a restricted role with no userId) that should not clutter bool.filter. The no-userId case still fails open within company scope — companyScopeClause remains the load-bearing tenant chokepoint.
  const roleClause = input.role
    ? roleVisibilityClause(input.role, input.userId)
    : undefined;
  const roleRestriction =
    roleClause && !("match_all" in roleClause) ? roleClause : undefined;

  const filter = [
    companyScopeClause(input.companyId), // ALWAYS first; throws if companyId missing
    termFilter("status", CURRENT_STATUS.ACTIVE), // ALWAYS — index stores INACTIVE/DELETED too
    termFilter("archived", input.showArchived === true), // ALWAYS — true=only archived, else only non-archived
    input.filterTags?.length &&
      termsFilter(
        "tags",
        input.filterTags.map((t) => t.toString()),
      ),
    input.filterUsers?.length &&
      termsFilter(
        "members",
        input.filterUsers.map((u) => u.toString()),
      ),
    // Filter by document id via the `ids` query (the supported form for the `_id` meta-field) — NOT a `terms` clause on `_id`. Single-project lookup wins over filterProjectsId (mirrors Mongo's `!projectId` guard); companyScopeClause above still applies — ES stays tenant-fail-closed even though Mongo's projectId branch drops company scope.
    input.projectId
      ? { ids: { values: [input.projectId.toString()] } }
      : input.filterProjectsId?.length && {
          ids: { values: input.filterProjectsId.map((p) => p.toString()) },
        },
    input.dateRange &&
      (input.dateRange.gte != null || input.dateRange.lte != null) &&
      rangeFilter("createdAt", input.dateRange),
    // Parity gap: companyScopeClause stays mandatory even for GUEST (where Mongo drops it), so a guest's cross-company guest-projects may under-return. Tenant isolation (fail-closed) wins over exact guest parity.
    roleRestriction,
  ].filter(Boolean) as QueryClause[];

  // Token match (all terms required, via operator:"and") OR phrase-prefix on name/description/location for as-you-type. operator:"and" stops a junk multi-token query (e.g. hyphen-split "zzz-no-such-project") from OR-matching a single common token like "project" and returning bogus hits. Phrase-prefix still powers type-ahead; mid-word substrings would need an edge-ngram reindex (out of scope — accepted parity gap).
  const bool: QueryClause = { filter };
  if (input.search) {
    bool.must = [
      {
        bool: {
          should: [
            {
              multi_match: {
                query: input.search,
                fields: ["name", "description", "location"],
                operator: "and",
              },
            },
            {
              multi_match: {
                query: input.search,
                fields: ["name", "description", "location"],
                type: "phrase_prefix",
              },
            },
          ],
          minimum_should_match: 1,
        },
      },
    ];
  }

  // The caller's per-user pinned projects, spliced ahead of this page by the handler — excluded
  // here so they can't also appear inside it.
  if (input.excludeProjectIds?.length) {
    bool.must_not = [
      {
        ids: {
          values: input.excludeProjectIds.map((p) => p.toString()),
        },
      },
    ];
  }

  // Clamp from/size to the ES max_result_window so a deep page mirrors Mongo's empty page instead of throwing "Result window is too large".
  // The handler passes an explicit from/size when pinned rows shift the unpinned offset; the page/pageSize form is the default.
  const { from, size } =
    input.from != null && input.size != null
      ? clampWindow(input.from, input.size)
      : paginationWindow(input.page, input.pageSize);

  // sortBy/sortOrder arrive pre-validated+defaulted by the handler (resolveProjectListSort). Pins are NOT a sort key: they are per-user, so the handler fetches them separately and prepends them. Parity gap: name sorts on name.keyword (case-sensitive, "Z" < "a") while Mongo applies a strength-2 collation — closing it needs a lowercase-normalizer keyword sub-field + reindex.
  const sortField =
    input.sortBy === "name" ? "name.keyword" : (input.sortBy ?? "updatedAt");
  const sortOrder = input.sortOrder ?? "desc";
  const request: QueryClause = {
    index: "projects", // alias, never the versioned concrete index
    routing: input.companyId.toString(), // shard routing
    body: {
      query: { bool },
      from,
      size,
      // Matches the shipped Mongo sort (single key; pinned-first is applied by the handler splice).
      sort: [{ [sortField]: sortOrder }],
      track_total_hits: true, // accurate totalCount vs Mongo countDocuments (ES default caps at 10000)
    },
  };

  // The clause helpers emit the project's structural `QueryClause`, which does not satisfy OpenSearch's exact DSL types; assert at this boundary (not `any` — request shape is verified by the DSL snapshot unit tests).
  return request as unknown as Search_Request;
};
