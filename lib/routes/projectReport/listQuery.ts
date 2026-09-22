import { Types } from "mongoose";
import { REPORT_STATUS } from "../../utils/enums/projectReports";
import { escapeRegExp } from "../../utils/helpers/commonHelper";

// Pure, DB-free helpers for the global report list endpoint. Extracted so the
// regression-prone bits (regex escaping, paging, pagination math, match shape)
// are unit-testable without a Mongo connection. Mirrors lib/routes/projects/
// dateRange.ts + listQuery.ts.

// Bound on user-supplied search text before it reaches $regex, so a huge
// pattern can't pin CPU. Matches the cap the task and checklist lists apply.
const SEARCH_MAX_LENGTH = 100;

// Escape user input so regex metacharacters can't alter or break the match.
// Delegates to the shared helper — kept as a named export because the unit
// tests and dateRange.ts reference it.
export const escapeReportSearch = (search: string): string =>
  escapeRegExp(String(search).slice(0, SEARCH_MAX_LENGTH));

// Normalize page/limit query params to safe positive integers with defaults.
export const normalizeReportListPaging = (query: {
  page?: string;
  limit?: string;
}): { page: number; limit: number } => {
  const page = query.page ? Math.max(parseInt(query.page, 10) || 1, 1) : 1;
  const limit = query.limit ? Math.max(parseInt(query.limit, 10) || 20, 1) : 20;
  return { page, limit };
};

// Build the $match stage for the membership-scoped global report list.
export const buildGlobalReportMatch = (
  projectIds: Types.ObjectId[],
  search?: string,
): Record<string, unknown> => {
  const match: Record<string, unknown> = {
    projectId: { $in: projectIds },
    status: { $ne: REPORT_STATUS.DELETED },
  };

  if (search) {
    match.reportName = { $regex: escapeReportSearch(search), $options: "i" };
  }

  return match;
};

// Compute the pagination envelope. Never reports fewer than 1 page.
export const reportListPagination = (
  total: number,
  limit: number,
): { total: number; totalPages: number } => ({
  total,
  totalPages: Math.max(Math.ceil(total / limit), 1),
});
