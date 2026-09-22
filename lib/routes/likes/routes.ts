import * as express from "express";
import * as status from "http-status";
import { SuccessResponse } from "../../utils/helpers/apiResponse";
import { LikesHelper } from "./helper";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";

export class LikesRoutes {
  public static like = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const { isLiked } = req.query;

      let temp = false;
      if (isLiked == "true") temp = true;
      await LikesHelper.like(req.query, userId, temp);
      return SuccessResponse(res, status.OK, {
        message: "update successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
