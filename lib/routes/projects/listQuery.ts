export enum PROJECT_LIST_SORT_BY {
  NAME = "name",
  CREATED_AT = "createdAt",
  UPDATED_AT = "updatedAt",
}

export type ProjectListSortOrder = "asc" | "desc";

export interface ProjectListSort {
  sortBy: PROJECT_LIST_SORT_BY;
  sortOrder: ProjectListSortOrder;
  mongoSort: Record<string, 1 | -1>;
  caseInsensitive: boolean;
}

// Resolves the projects.list sortBy/sortOrder query params into a Mongo $sort spec. Pins are NOT part of this sort any more: they are per-user (projectpins collection), so the handler fetches the caller's pinned rows separately and splices them ahead of this ordering. Defaults: no sortBy → updatedAt desc (shipped behavior); name → asc; createdAt/updatedAt → desc. Throws on unknown values — the handler maps that to a 422, mirroring parseProjectListDateRange.
export const resolveProjectListSort = (
  sortBy?: string,
  sortOrder?: string,
): ProjectListSort => {
  const field = (sortBy || PROJECT_LIST_SORT_BY.UPDATED_AT) as string;
  if (
    !Object.values(PROJECT_LIST_SORT_BY).includes(field as PROJECT_LIST_SORT_BY)
  ) {
    throw new Error(
      `Invalid sortBy "${sortBy}" — expected one of ${Object.values(
        PROJECT_LIST_SORT_BY,
      ).join(", ")}`,
    );
  }
  if (sortOrder && sortOrder !== "asc" && sortOrder !== "desc") {
    throw new Error(`Invalid sortOrder "${sortOrder}" — expected asc or desc`);
  }

  const resolvedField = field as PROJECT_LIST_SORT_BY;
  const defaultOrder: ProjectListSortOrder =
    resolvedField === PROJECT_LIST_SORT_BY.NAME ? "asc" : "desc";
  const resolvedOrder = (sortOrder as ProjectListSortOrder) || defaultOrder;

  return {
    sortBy: resolvedField,
    sortOrder: resolvedOrder,
    mongoSort: {
      [resolvedField]: resolvedOrder === "asc" ? 1 : -1,
    },
    // Alphabetical sort should not split "apple" and "Apple" — the Mongo path applies a strength-2 collation for name sorts only.
    caseInsensitive: resolvedField === PROJECT_LIST_SORT_BY.NAME,
  };
};

export const applyProjectCreatedAtDateRange = (
  query: Record<string, unknown>,
  dateRange?: { startDate: Date; endDate: Date },
): void => {
  if (dateRange?.startDate && dateRange?.endDate) {
    query.createdAt = {
      $gte: dateRange.startDate,
      $lte: dateRange.endDate,
    };
  }
};
