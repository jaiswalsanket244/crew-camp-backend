// Output shape for GET /api/admin/search/status: live fields come from OpenSearch cluster.health(); the rest are placeholders filled in later (via assembleStatus()).
export interface SearchClusterStatusType {
  status: "green" | "yellow" | "red";
  nodeCount: number;
  pendingTasks: number;
  indices: unknown[]; // [] placeholder — populated with per-index detail later
  indexingLagP99Ms: number | null; // null placeholder
  fallbackRatePerRoute: Record<string, number>; // {} placeholder
  flagsByCompany: Record<string, unknown>; // {} placeholder
}

// Result of a search backfill run (backfillProjects, reused by the posts_uploads backfill).
export interface BackfillResult {
  index: string;
  companiesProcessed: number;
  companiesSkipped: number; // companies skipped (e.g. null companyId — unroutable)
  documentsIndexed: number; // successfully indexed (excludes per-item bulk failures)
  failures: number;
}
