import * as express from "express";
import * as status from "http-status";
import { Review } from "../../db/index";
import { SuccessResponse } from "../../utils/helpers/apiResponse";

export class ReviewRoutes {
  public static async create(
    req: express.Request,
    res: express.Response,
    next,
  ) {
    try {
      const review = req.body;
      const data = await Review.create(review);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  }
}
