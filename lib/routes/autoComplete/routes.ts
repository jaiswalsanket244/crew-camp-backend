// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { AutoCompleteHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { SuccessResponse } from "../../utils/helpers/apiResponse";

export class AutoCompleteRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await AutoCompleteHelpers.findAll(req.query);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
