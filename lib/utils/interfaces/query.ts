import { Types } from "mongoose";

export interface PaginatedSearchQuery {
  page: number;
  pageSize: number;
  skips: number;
  searchValue?: string;
  filter?: any;
  companyId?: string;
  sortBy?: string;
  referredBy?: string;
  limit?: number;
}

export interface MyUploadsQuery {
  projectId?: string;
  projectIds?: any;
  userId?: string;
  dateRange?: any;
  lastMonth: boolean;
  postId: string;
  filterProjects?: string;
  filterUsers?: string;
  filterPostTags?: string;
  filterProjectTags?: string;
  search?: string;
  isGridView?: boolean;
}
export interface ProjectScrollQuery {
  projectId: Types.ObjectId;
  page?: number | string;
  limit?: number | string;
  userId?: string;
  filterUsers?: string;
  filterPostTags?: string;
  search?: string;
  dateRange?: { startDate: Date | string; endDate: Date | string };
}

export type SearchQueryWithSelectedFilters = PaginatedSearchQuery & {
  selectedFilters?: {
    projects?: string[];
    userRoles?: string[];
  };
};
