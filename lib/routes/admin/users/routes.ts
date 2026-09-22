// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { AdminUsersHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import { SuccessResponse } from "../../../utils/helpers/apiResponse";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";

export class AdminUsersRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery = req.query;
      const data = await AdminUsersHelpers.findAll(query);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getOne = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { id }: { id: string } = req.params;
      const data = await AdminUsersHelpers.findOne(id);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
