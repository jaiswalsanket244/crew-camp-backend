import * as express from "express";
import * as status from "http-status";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import { StripePaymentHelpers } from "./helpers";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../../utils/helpers/apiResponse";

export class StripePaymentRoutes {
  public static getAllCharges = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;
      const { balance, charges } =
        await StripePaymentHelpers.getAllChargesSuperAdmin(query);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: { balance, charges },
      });
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };

  public static getAllPayouts = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;
      const data = await StripePaymentHelpers.getAllPayouts(query);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };

  public static createPayout = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { amount } = req.body;
      const data = await StripePaymentHelpers.createPayout(amount);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };

  public static getAllSellers = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;
      const sellers = await StripePaymentHelpers.getAllSellersSuperAdmin(query);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: sellers,
      });
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };

  public static getSellerChargesWithBalance = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { sellerStripeAccountId } = req.params;
      const query = req.query;
      const data = await StripePaymentHelpers.getAllSellerCharges(
        sellerStripeAccountId,
        query,
      );
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };
}
