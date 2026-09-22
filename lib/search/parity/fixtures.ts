import { SORT_TYPE } from "../../utils/enums/post";

// The canonical query fixture set for the ES↔Mongo parity harness. Lives in lib/search/ (NOT test/) because the rootDir is lib/ → server/ and the runner + CI import the COMPILED fixtures — a lib/ module cannot import from test/. Each fixture's `input` mirrors the SHIPPED req.query of its route's handler INCLUDING the handlers' quirks (filter arrays are JSON strings, dateRange is JSON {startDate,endDate}, the uploads free-text search is the misnamed `postId` param, uploads page size is `limit`). `actor.companyRole` expresses the role-visibility matrix; the runner injects the concrete companyId/userId per target company — fixtures NEVER hardcode them. RULE: any PR that adds a new filter dimension to a builder/handler MUST add (or extend) a fixture here (enforced in CI).

export interface QueryFixture {
  name: string;
  route: "projects.list" | "posts.uploads";
  // req.query-shaped input for the route's handler (arrays as JSON strings, dateRange as JSON).
  input: Record<string, unknown>;
  // Auth context the runner builds req.user from (companyId/userId injected per company). "GUEST" is a test-actor marker (not a USER_ROLE) that drives the runner's guest handling (projects also set input.role="GUEST"; uploads guests bypass searchWithFallback entirely).
  actor: { companyRole: "ADMIN" | "LIMITED" | "CREW" | "GUEST" };
  // Parity comparison tolerance. Omitted fields default to exact, ordered, full-field equality.
  tolerance: {
    ignoreFields?: string[]; // fields that legitimately differ (e.g. mongoUpdatedAt, ES _score)
    ignoreOrder?: boolean; // set-equality where ES collapse/sort orders differently
    maxResultDiff?: number; // allowed item-count delta for documented boundary/count nuances
  };
}

// Placeholder 24-hex ids for filter values (structurally valid for ObjectId() parsing); an operator can swap in a real company's ids on staging, and the unfiltered baseline/sort/pagination fixtures already exercise real result sets.
const TAG_A = "000000000000000000000a01";
const TAG_B = "000000000000000000000a02";
const USER_A = "000000000000000000000b01";
const USER_B = "000000000000000000000b02";
const PROJECT_A = "000000000000000000000c01";
const PROJECT_B = "000000000000000000000c02";
const DATE_RANGE = JSON.stringify({
  startDate: "2025-01-01",
  endDate: "2025-12-31",
});

// ── projects.list (getAllDataV2) ─────────────────────────────────────────────────────────────
const PROJECTS_FIXTURES: QueryFixture[] = [
  {
    name: "projects: baseline (empty filters, admin)",
    route: "projects.list",
    input: { page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: tags only",
    route: "projects.list",
    input: { filterTags: JSON.stringify([TAG_A]), page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: members only (filterUsers)",
    route: "projects.list",
    input: { filterUsers: JSON.stringify([USER_A]), page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: date range only",
    route: "projects.list",
    input: { dateRange: DATE_RANGE, page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: archived only",
    route: "projects.list",
    // showArchived is a req.query string; both paths compare `=== "true"` (helper.ts / routes.ts).
    input: { showArchived: "true", page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: search empty string",
    route: "projects.list",
    input: { search: "", page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: search prefix",
    route: "projects.list",
    input: { search: "Pro", page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    // ES multi_match vs Mongo regex may rank/return differently.
    tolerance: { ignoreOrder: true },
  },
  {
    name: "projects: search substring",
    route: "projects.list",
    input: { search: "ject", page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    // EXPECTED-DIVERGENT: ES matches whole tokens + prefixes, NOT mid-word infixes ("ject" is not a token of "Project"), while Mongo runs a substring regex. Accepted gap (mid-word substring is out of scope — would need an edge-ngram reindex). Bounded by page size so a gross both-sides-large divergence still FAILS.
    tolerance: { ignoreOrder: true, maxResultDiff: 50 },
  },
  {
    name: "projects: search no-match",
    route: "projects.list",
    input: { search: "zzz-no-such-project-zzz", page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: pairwise tags + date range",
    route: "projects.list",
    input: {
      filterTags: JSON.stringify([TAG_A, TAG_B]),
      dateRange: DATE_RANGE,
      page: 1,
      pageSize: 50,
    },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: pairwise members + archived",
    route: "projects.list",
    input: {
      filterUsers: JSON.stringify([USER_A]),
      showArchived: "true",
      page: 1,
      pageSize: 50,
    },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: pairwise search + tags",
    route: "projects.list",
    input: {
      search: "Pro",
      filterTags: JSON.stringify([TAG_A]),
      page: 1,
      pageSize: 50,
    },
    actor: { companyRole: "ADMIN" },
    tolerance: { ignoreOrder: true },
  },
  {
    name: "projects: full-compound (all dimensions)",
    route: "projects.list",
    input: {
      search: "Pro",
      filterTags: JSON.stringify([TAG_A, TAG_B]),
      filterUsers: JSON.stringify([USER_A, USER_B]),
      dateRange: DATE_RANGE,
      showArchived: "false",
      page: 1,
      pageSize: 50,
    },
    actor: { companyRole: "ADMIN" },
    tolerance: { ignoreOrder: true },
  },
  {
    name: "projects: pagination page 1",
    route: "projects.list",
    input: { page: 1, pageSize: 10 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: pagination mid (page 5)",
    route: "projects.list",
    input: { page: 5, pageSize: 10 },
    actor: { companyRole: "ADMIN" },
    // Collapse/sort boundary ordering may differ across pages.
    tolerance: { ignoreOrder: true },
  },
  {
    name: "projects: pagination near-last (page N-1, large page)",
    route: "projects.list",
    input: { page: 1, pageSize: 500 },
    actor: { companyRole: "ADMIN" },
    tolerance: { ignoreOrder: true },
  },
  {
    name: "projects: pagination beyond range (page N+1 → empty)",
    route: "projects.list",
    input: { page: 9999, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: role variant ADMIN (company-wide)",
    route: "projects.list",
    input: { page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "projects: role variant LIMITED (restricted to own projects)",
    route: "projects.list",
    input: { page: 1, pageSize: 50 },
    actor: { companyRole: "LIMITED" },
    tolerance: {},
  },
  {
    name: "projects: role variant CREW (restricted to own projects)",
    route: "projects.list",
    input: { page: 1, pageSize: 50 },
    actor: { companyRole: "CREW" },
    tolerance: {},
  },
  {
    name: "projects: role variant GUEST (guest-project scope)",
    route: "projects.list",
    // Projects guest scope is driven by req.query.role (getAllDataV2 reads it), NOT just the actor — unlike LIMITED/CREW which come from req.user.companies[].role. Both are set so either gate fires.
    input: { role: "GUEST", page: 1, pageSize: 50 },
    actor: { companyRole: "GUEST" },
    tolerance: {},
  },
  {
    name: "projects: recentPosts shape + 4-vs-5 off-by-one nuance",
    route: "projects.list",
    input: { page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    // Deferred: grid keeps 4 recent posts, index keeps 5; clean-array vs array-of-arrays.
    tolerance: { ignoreFields: ["recentPosts"], maxResultDiff: 0 },
  },
  {
    name: "projects: 0-vs-null empty-count parity nuance",
    route: "projects.list",
    input: { page: 1, pageSize: 50 },
    actor: { companyRole: "ADMIN" },
    // Deferred: empty counts are 0 on one path, null/absent on the other.
    tolerance: { ignoreFields: ["members", "crews", "comments", "posts"] },
  },
];

// ── posts.uploads (getUploads) ───────────────────────────────────────────────────────────────
const UPLOADS_FIXTURES: QueryFixture[] = [
  {
    name: "uploads: baseline (empty filters, admin)",
    route: "posts.uploads",
    input: { page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: tags only (filterPostTags)",
    route: "posts.uploads",
    input: { filterPostTags: JSON.stringify([TAG_A]), page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: uploaders only (filterUsers)",
    route: "posts.uploads",
    input: { filterUsers: JSON.stringify([USER_A]), page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: single uploader (userId)",
    route: "posts.uploads",
    input: { userId: USER_A, page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: projects only (filterProjects)",
    route: "posts.uploads",
    input: { filterProjects: JSON.stringify([PROJECT_A]), page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: single project (projectId)",
    route: "posts.uploads",
    input: { projectId: PROJECT_A, page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: project-tag filter (filterProjectTags)",
    route: "posts.uploads",
    // filterProjectTags is a distinct getUploads dimension (resolves to projects, then their posts). Admin path applies it; non-admins ignore it, so this stays ADMIN.
    input: {
      filterProjectTags: JSON.stringify([TAG_A]),
      page: 1,
      limit: 50,
    },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: date range only",
    route: "posts.uploads",
    input: { dateRange: DATE_RANGE, page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: lastMonth date variant",
    route: "posts.uploads",
    input: { lastMonth: true, page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: search empty (postId param)",
    route: "posts.uploads",
    input: { postId: "", page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: search prefix (postId param)",
    route: "posts.uploads",
    input: { postId: "note", page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    // Deferred: ES analyzed match on file note vs Mongo regex on Post.note — EXPECTED-DIVERGENT. Bounded by page size (50) so a fully-disjoint result set (diff≈100) still FAILS (surfacing gross divergence) while tolerating partial regex-vs-match overlap.
    tolerance: { ignoreOrder: true, maxResultDiff: 50 },
  },
  {
    name: "uploads: search substring (postId param)",
    route: "posts.uploads",
    input: { postId: "oo", page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: { ignoreOrder: true, maxResultDiff: 50 },
  },
  {
    name: "uploads: search no-match (postId param)",
    route: "posts.uploads",
    input: { postId: "zzz-no-such-note-zzz", page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: sort NEWEST (default)",
    route: "posts.uploads",
    input: { sortBy: SORT_TYPE.NEWEST, page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    // Collapse top-file (createdAt desc) vs Mongo $min(createdAt) ordering — boundary nuance.
    tolerance: { ignoreOrder: true },
  },
  {
    name: "uploads: sort OLDEST",
    route: "posts.uploads",
    input: { sortBy: SORT_TYPE.OLDEST, page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: { ignoreOrder: true },
  },
  {
    name: "uploads: sort DATE_TAKEN_ASC (ES path routes to Mongo → expect parity)",
    route: "posts.uploads",
    input: { sortBy: SORT_TYPE.DATE_TAKEN_ASC, page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    // Timestamp-sort is Mongo-routed on both paths → exact parity expected.
    tolerance: {},
  },
  {
    name: "uploads: sort DATE_TAKEN_DESC (ES path routes to Mongo → expect parity)",
    route: "posts.uploads",
    input: { sortBy: SORT_TYPE.DATE_TAKEN_DESC, page: 1, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: pairwise tags + date range",
    route: "posts.uploads",
    input: {
      filterPostTags: JSON.stringify([TAG_A, TAG_B]),
      dateRange: DATE_RANGE,
      page: 1,
      limit: 50,
    },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: pairwise uploaders + projects",
    route: "posts.uploads",
    input: {
      filterUsers: JSON.stringify([USER_A]),
      filterProjects: JSON.stringify([PROJECT_A, PROJECT_B]),
      page: 1,
      limit: 50,
    },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: full-compound (all dimensions)",
    route: "posts.uploads",
    input: {
      postId: "note",
      filterPostTags: JSON.stringify([TAG_A]),
      filterUsers: JSON.stringify([USER_A]),
      filterProjects: JSON.stringify([PROJECT_A]),
      dateRange: DATE_RANGE,
      sortBy: SORT_TYPE.NEWEST,
      page: 1,
      limit: 50,
    },
    actor: { companyRole: "ADMIN" },
    // Compound includes the divergent note-search dimension — bounded by page size (see search fixtures).
    tolerance: { ignoreOrder: true, maxResultDiff: 50 },
  },
  {
    name: "uploads: pagination page 1",
    route: "posts.uploads",
    input: { page: 1, limit: 10 },
    actor: { companyRole: "ADMIN" },
    tolerance: { ignoreOrder: true },
  },
  {
    name: "uploads: pagination mid (page 5)",
    route: "posts.uploads",
    input: { page: 5, limit: 10 },
    actor: { companyRole: "ADMIN" },
    tolerance: { ignoreOrder: true },
  },
  {
    name: "uploads: pagination large page (page N-1)",
    route: "posts.uploads",
    input: { page: 1, limit: 200 },
    actor: { companyRole: "ADMIN" },
    tolerance: { ignoreOrder: true },
  },
  {
    name: "uploads: pagination beyond range (page N+1 → empty)",
    route: "posts.uploads",
    input: { page: 9999, limit: 50 },
    actor: { companyRole: "ADMIN" },
    tolerance: {},
  },
  {
    name: "uploads: collapse top-file ordering nuance (multi-file posts)",
    route: "posts.uploads",
    input: { sortBy: SORT_TYPE.NEWEST, page: 2, limit: 25 },
    actor: { companyRole: "ADMIN" },
    // Deferred: ES collapse keeps newest file per post; Mongo orders by $min(createdAt).
    tolerance: { ignoreOrder: true, maxResultDiff: 2 },
  },
  {
    name: "uploads: role variant LIMITED",
    route: "posts.uploads",
    input: { page: 1, limit: 50 },
    actor: { companyRole: "LIMITED" },
    tolerance: {},
  },
  {
    name: "uploads: role variant CREW",
    route: "posts.uploads",
    input: { page: 1, limit: 50 },
    actor: { companyRole: "CREW" },
    tolerance: {},
  },
  {
    name: "uploads: role variant GUEST (no companyId → both paths Mongo)",
    route: "posts.uploads",
    input: { page: 1, limit: 50 },
    actor: { companyRole: "GUEST" },
    // Guests bypass searchWithFallback → both paths serve Mongo → exact parity.
    tolerance: {},
  },
];

export const QUERY_FIXTURES: QueryFixture[] = [
  ...PROJECTS_FIXTURES,
  ...UPLOADS_FIXTURES,
];
