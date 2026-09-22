import * as status from "http-status";
import * as express from "express";
import { FcmTokensHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { Validator } from "node-input-validator";
import { FcmTokenType } from "../../utils/interfaces/schemaInterface";

export class FcmTokensRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await FcmTokensHelpers.findAll(req.query);
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
      const id = req.params.id;
      const data = await FcmTokensHelpers.findOne(id);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        token: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { token } = req.body;

      const userId = req.user._id;

      await FcmTokensHelpers.create(userId,token);

      return SuccessResponse(res, status.OK, {
        message: "fcmToken created successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static update = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const id = req.params.id;
      const { update }: { update: FcmTokenType } = req.body;
      const data = await FcmTokensHelpers.findAndUpdate({ id, update });
      return SuccessResponse(res, status.OK, {
        message: "Data updated successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getUserTokens = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const data = await FcmTokensHelpers.getUserTokens(userId);
      return SuccessResponse(res, status.OK, {
        message: "Token retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteToken = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const token = req.params.token;
      const userId = req.user._id;
      const data = await FcmTokensHelpers.deleteToken(token, userId);
      return SuccessResponse(res, status.OK, {
        message: "Token deleted successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
