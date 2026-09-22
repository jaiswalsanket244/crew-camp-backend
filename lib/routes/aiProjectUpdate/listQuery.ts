import { Types } from "mongoose";
import { AI_PROJECT_UPDATE_STATUS } from "../../utils/enums/aiProjectUpdate";

// Pure, DB-free helpers for the project-update list endpoint, mirroring
// lib/routes/projectReport/listQuery.ts so paging, search escaping and the
// match shape are unit-testable without a Mongo connection.
//
// escapeRegExp is inlined rather than imported from commonHelper: that module
// pulls in ../../db, and loading the model graph under ts-node is what keeps
// the existing listQuery tests from running. Same expression, no dependency.
const escapeRegExp = (input: string): string =>
  String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SEARCH_MAX_LENGTH = 100;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const escapeUpdateSearch = (search: string): string =>
  escapeRegExp(String(search).slice(0, SEARCH_MAX_LENGTH));

// page >= 1; 1 <= limit <= MAX_LIMIT; non-numeric input falls back to defaults.
export const normalizeUpdateListPaging = (query: {
  page?: string;
  limit?: string;
}): { page: number; limit: number } => {
  const page = query.page ? Math.max(parseInt(query.page, 10) || 1, 1) : 1;
  const rawLimit = query.limit
    ? parseInt(query.limit, 10) || DEFAULT_LIMIT
    : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
  return { page, limit };
};

// Company is folded into the match so a foreign project is simply empty,
// never a 403 — the same posture as the daily-log list.
export const buildUpdateListMatch = (
  projectId: Types.ObjectId,
  companyId: Types.ObjectId,
  search?: string,
): Record<string, unknown> => {
  const match: Record<string, unknown> = {
    projectId,
    companyId,
    status: { $ne: AI_PROJECT_UPDATE_STATUS.DELETED },
  };

  const trimmed = search?.trim();
  if (trimmed) {
    match.title = { $regex: escapeUpdateSearch(trimmed), $options: "i" };
  }

  return match;
};

export const updateListPagination = (
  total: number,
  limit: number,
): { total: number; totalPages: number } => ({
  total,
  totalPages: Math.max(Math.ceil(total / limit), 1),
});
