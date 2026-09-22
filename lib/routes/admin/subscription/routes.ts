import * as express from "express";
import * as status from "http-status";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import { SubscriptionHelpers } from "./helpers";
import { SuccessResponse } from "../../../utils/helpers/apiResponse";

export class SubscriptionRoutes {
  public static getAllSubscribedUsers = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;

      const data = await SubscriptionHelpers.findAll({
        page: Number(query.page ?? 1),
        skips: 0,
        pageSize: Number(query.pageSize ?? 50),
        searchValue: String(query.searchValue ?? ""),
        filter: query.filter,
      });

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
