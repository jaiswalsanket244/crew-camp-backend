import * as httpStatus from "http-status";
import * as express from "express";

import { config } from "../../utils/configuration/config";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")(config.STRIPE_SECRET_KEY);
import { OrdersHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  SuccessResponse,
  ErrorResponse,
} from "../../utils/helpers/apiResponse";
import { Validator } from "node-input-validator";

export class OrderRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await OrdersHelpers.findAll(req.query);
      return SuccessResponse(res, httpStatus.OK, { message: "Success.", data });
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

      const data = await OrdersHelpers.findOne(id);
      return SuccessResponse(res, httpStatus.OK, { message: "Success.", data });
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
      const userId = req.user._id;
      const { update } = req.body;
      const data = await OrdersHelpers.findAndUpdate(id, userId, update);
      if (!data) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Bad request. check the body",
        });
      }
      return SuccessResponse(res, httpStatus.OK, {
        message: "Success.",
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
      const user = req.user;
      const { payment_intent, productId } = req.body;

      const validator = new Validator(req.body, {
        payment_intent: "required",
        productId: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, httpStatus.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const chargeId = await OrdersHelpers.getChargeId(payment_intent);
      const charge = await stripe.charges.retrieve(chargeId);

      const { payment_method_details, id, status } = charge;

      const document = {
        chargeId: id,
        userId: user._id,
        productId,
        paymentStatus: status,
        paymentMethodDetails: payment_method_details,
      };
      const data = await OrdersHelpers.create(document);
      return SuccessResponse(res, httpStatus.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };

  public static delete = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const id = req.params.id;
      const user = req.user;
      const userId = req.user._id;
      const data = await OrdersHelpers.softDelete(id, userId, user);
      if (!data) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Authentication error!",
        });
      }
      return SuccessResponse(res, httpStatus.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };
}
