import * as status from "http-status";
import * as express from "express";
import * as mongoose from "mongoose";
import { Validator } from "node-input-validator";

import { AdminSearchHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import {
  SuccessResponse,
  ErrorResponse,
} from "../../../utils/helpers/apiResponse";
import { SEARCH_JOB_TYPES, SEARCH_JOB_INDEXES } from "../../../db/searchJobs";

export class AdminSearchRoutes {
  public static getStatus = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await AdminSearchHelpers.getClusterHealth();
      return SuccessResponse(res, status.OK, {
        message: "Search cluster status retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  // POST /api/admin/search/flag (super-admin) — enable/disable the ES read path for a (companyId, route) pair. Writes the SearchFlag the isSearchEnabled cache reads; propagates to all pods within the 30s TTL.
  public static setFlag = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        companyId: "required|string",
        route: "required|string|in:projects.list,posts.uploads",
        enabled: "required|boolean",
      });
      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { companyId, route, enabled } = req.body;
      if (!mongoose.isValidObjectId(companyId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid companyId",
        });
      }

      const updatedBy = req.user._id;
      const flag = await AdminSearchHelpers.upsertFlag(
        companyId,
        route,
        enabled,
        updatedBy,
      );

      // Structured audit log.
      console.log("search.flag.flipped", {
        service: "search",
        tag: "search.flag.flipped",
        companyId,
        route,
        enabled,
        updatedBy: String(updatedBy),
      });

      return SuccessResponse(res, status.OK, {
        message: "Flag updated",
        data: { flag },
      });
    } catch (error) {
      next(error);
    }
  };

  // POST /api/admin/search/reindex (super-admin) — enqueue a reindex job: inserts a PENDING SearchJob the search-worker executes. Returns 202.
  public static enqueueReindex = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        type: `required|string|in:${SEARCH_JOB_TYPES.join(",")}`,
        index: `required|string|in:${SEARCH_JOB_INDEXES.join(",")}`,
        companyId: "string",
        since: "string",
      });
      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: `Validation error. type must be one of: ${SEARCH_JOB_TYPES.join(
            ", ",
          )}; index must be one of: ${SEARCH_JOB_INDEXES.join(", ")}.`,
          errors: validator.errors,
        });
      }

      const { type, index, companyId, since } = req.body;
      if (type === "REINDEX_COMPANY" && !mongoose.isValidObjectId(companyId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "companyId (valid ObjectId) is required for REINDEX_COMPANY",
        });
      }
      if (
        type === "REINDEX_INCREMENTAL" &&
        (!since || isNaN(Date.parse(since)))
      ) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "since (ISO date) is required for REINDEX_INCREMENTAL",
        });
      }

      // Persist only the fields relevant to the job type (a REINDEX_FULL job carries neither companyId nor since) so the worker can trust each field by type.
      const jobCompanyId = type === "REINDEX_COMPANY" ? companyId : undefined;
      const jobSince = type === "REINDEX_INCREMENTAL" ? since : undefined;

      const triggeredBy = req.user._id;
      const job = await AdminSearchHelpers.enqueueReindexJob({
        type,
        index,
        companyId: jobCompanyId,
        since: jobSince,
        triggeredBy,
      });
      const jobId = job._id;

      console.log("search.reindex.start", {
        service: "search",
        tag: "search.reindex.start",
        jobId: String(jobId),
        type,
        index,
        companyId: jobCompanyId,
        triggeredBy: String(triggeredBy),
      });

      return SuccessResponse(res, status.ACCEPTED, {
        message: "Reindex job enqueued",
        data: { jobId },
      });
    } catch (error) {
      next(error);
    }
  };

  // POST /api/admin/search/default (super-admin) — set the route-level DEFAULT flag: enables/disables the ES read path for ALL companies (present + future) on a route in this environment; per-company flags still override it. Ships default-OFF — this is the GA switch.
  public static setRouteDefault = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        route: "required|string|in:projects.list,posts.uploads",
        enabled: "required|boolean",
      });
      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { route, enabled } = req.body;
      const updatedBy = req.user._id;
      const routeDefault = await AdminSearchHelpers.upsertRouteDefault(
        route,
        enabled,
        updatedBy,
      );

      console.log("search.flag.default.flipped", {
        service: "search",
        tag: "search.flag.default.flipped",
        route,
        enabled,
        updatedBy: String(updatedBy),
      });

      return SuccessResponse(res, status.OK, {
        message: "Route default updated",
        data: { default: routeDefault },
      });
    } catch (error) {
      next(error);
    }
  };
}
