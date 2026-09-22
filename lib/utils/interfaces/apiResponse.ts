export interface ApiResponseType {
  success?: boolean;
  message?: string;
  data?: any;
  errors?: any;
  totalCounts?: number;
  nextCursor?: string | null;
}
