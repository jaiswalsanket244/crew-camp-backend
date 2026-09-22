export { SearchClientService } from "./searchClient";
export { emitSearchMetric } from "./emitMetric";
export {
  TenantScopeRequiredError,
  companyScopeClause,
  termFilter,
  termsFilter,
  rangeFilter,
  roleVisibilityClause,
} from "./builders/clauses";
export { buildProjectListQuery } from "./builders/projectListQuery";
export { buildPostsUploadsQuery } from "./builders/postsUploadsQuery";
export {
  GLOBAL_REQUEST_TIMEOUT_MS,
  PROJECTS_LIST_REQUEST_TIMEOUT_MS,
  POSTS_UPLOADS_REQUEST_TIMEOUT_MS,
} from "./builders/timeouts";
export { searchWithFallback, classifySearchError } from "./withFallback";
export type { SearchErrorReason } from "./withFallback";
