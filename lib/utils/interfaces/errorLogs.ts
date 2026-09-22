export interface ErrorLogsQueryParams {
  from?: string;
  to?: string;
  timeFrom?: string;
  timeTo?: string;
  timezone?: string;
  errorType?: string;
  messageContains?: string;
  source?: string;
  page?: string;
  limit?: string;
  sortBy?: "occurredAt" | "createdAt";
  sortOrder?: "asc" | "desc";
  includeStack?: string;
}

export interface FormattedDate {
  iso: string;
  readable: string;
}

export interface ErrorLogResponseRecord {
  id: string;
  type: string;
  eventType: string;
  category: string;
  description: string;
  occurredAt: FormattedDate;
  createdAt: FormattedDate;
  details: Record<string, unknown>;
  stackTrace: string | null;
}

export interface ErrorLogsListResponse {
  summary: {
    matched: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
  filters: Record<string, unknown>;
  records: ErrorLogResponseRecord[];
}
