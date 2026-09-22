import { Request, Response, NextFunction } from "express";
import * as status from "http-status";
import {
  SuccessResponse,
  ErrorResponse,
} from "../../utils/helpers/apiResponse";
import { ErrorLogsHelpers } from "./helpers";
import {
  ErrorLogsQueryParams,
  ErrorLogsListResponse,
} from "../../utils/interfaces/errorLogs";

const DEFAULT_LOOKBACK_DAYS = 7;

const normalizeQuery = (
  q: Record<string, unknown>,
): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(q || {})) {
    const key = k.trim();
    if (!key) continue;
    if (typeof v === "string") {
      out[key] = v.trim();
    } else if (Array.isArray(v) && v.length > 0) {
      out[key] = String(v[0] ?? "").trim();
    } else if (v != null) {
      out[key] = String(v).trim();
    }
  }
  return out;
};

const isValidDate = (s: string): boolean => {
  if (!s) return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
};

const isValidTimeOfDay = (s: string): boolean => {
  if (!s) return false;
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
};

export class ErrorLogsRoutes {
  // GET /api/error-logs — paginated list of error logs.
  // All filters are optional; defaults apply when none are provided.
  public static list = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const params = normalizeQuery(
        req.query as Record<string, unknown>,
      ) as ErrorLogsQueryParams;

      if (params.from && !isValidDate(params.from)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message:
            "Invalid 'from' date. Use YYYY-MM-DD or ISO format e.g. 2026-06-10T00:00:00Z.",
        });
      }
      if (params.to && !isValidDate(params.to)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message:
            "Invalid 'to' date. Use YYYY-MM-DD or ISO format e.g. 2026-06-10T23:59:59Z.",
        });
      }
      if (params.timeFrom && !isValidTimeOfDay(params.timeFrom)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message:
            "Invalid 'timeFrom'. Use 24-hour HH:MM format e.g. 23:00 for 11 PM.",
        });
      }
      if (params.timeTo && !isValidTimeOfDay(params.timeTo)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid 'timeTo'. Use 24-hour HH:MM format e.g. 23:59.",
        });
      }

      // Apply default time range if neither `from` nor `to` was given.
      const appliedFrom =
        params.from ||
        (!params.to
          ? new Date(
              Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString()
          : undefined);

      const effectiveParams: ErrorLogsQueryParams = {
        ...params,
        from: appliedFrom,
      };

      const filter = ErrorLogsHelpers.buildFilter(effectiveParams);
      const opts = ErrorLogsHelpers.parseOptions(effectiveParams);

      const [docs, matched] = await Promise.all([
        ErrorLogsHelpers.find(filter, opts),
        ErrorLogsHelpers.count(filter),
      ]);

      const records = docs.map((d) =>
        ErrorLogsHelpers.toResponseRecord(
          d as Record<string, unknown>,
          opts.includeStack,
          params.timezone || "UTC",
        ),
      );

      const totalPages = Math.ceil(matched / opts.limit) || 1;

      const data: ErrorLogsListResponse = {
        summary: {
          matched,
          page: opts.page,
          limit: opts.limit,
          totalPages,
          hasMore: opts.page < totalPages,
        },
        filters: {
          from: appliedFrom || null,
          to: params.to || null,
          timeFrom: params.timeFrom || null,
          timeTo: params.timeTo || null,
          timezone: params.timezone || null,
          errorType: params.errorType || null,
          messageContains: params.messageContains || null,
          source: params.source || null,
          sortBy: opts.sort,
          defaultApplied: !params.from && !params.to,
        },
        records,
      };

      return SuccessResponse(res, status.OK, {
        message: "Error logs retrieved successfully.",
        data,
      });
    } catch (err) {
      next(err);
    }
  };
}
