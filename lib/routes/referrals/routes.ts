import * as status from "http-status";
import * as express from "express";
import { ReferralHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { SuccessResponse } from "../../utils/helpers/apiResponse";

export class ReferralRoutes {
  public static getAllReferrals = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await ReferralHelpers.findAll(req.query);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };
}
