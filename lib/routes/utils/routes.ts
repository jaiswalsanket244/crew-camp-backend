import * as status from "http-status";
import * as express from "express";
import { UtilsHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import * as mongoose from "mongoose";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { getAddressFromCoordinates } from "../../services/google";
import { Validator } from "node-input-validator";
export class UtilsRoutes {
  public static findAllCollections = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const removeThese = new Set([
        "users",
        "payments",
        "reviews",
        "invitedusers",
        "refunds",
        "companies",
        "fcmtokens",
      ]);

      const collectionNames = Object.keys(
        mongoose.connections[0].collections,
      ).filter((name) => !removeThese.has(name));

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data: { names: collectionNames },
      });
    } catch (error) {
      next(error);
    }
  };

  public static findAllSidebarItems = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await UtilsHelpers.findSidebarItems(req.user.email);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getAddressFromCoordinates = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        lat: "string|required",
        lng: "string|required",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const { lat, lng } = req.query;

      const data = await getAddressFromCoordinates(lat, lng);
      return SuccessResponse(res, status.OK, {
        message: "Address sent successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
