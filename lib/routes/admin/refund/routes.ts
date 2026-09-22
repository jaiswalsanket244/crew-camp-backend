// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { RefundHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import { config } from "../../../utils/configuration/config";
import { OrdersHelpers } from "../../orders/helpers";
import { SuccessResponse } from "../../../utils/helpers/apiResponse";
import { RefundType } from "../../../utils/interfaces/schemaInterface";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")(config.STRIPE_SECRET_KEY);

export class RefundsRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery = req.query;
      const data = await RefundHelpers.findAll(query);
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
      const id: string = req.params.id;
      const data = await RefundHelpers.findOne(id);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
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
      const { update }: { update: RefundType } = req.body;
      const data = await RefundHelpers.findAndUpdate({ id, update });
      return SuccessResponse(res, status.OK, {
        message: "Data updated successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static initiateRefund = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { amount, chargeId, reason, orderId, refundId } = req.body;

      const refund = await stripe.refunds.create(
        {
          charge: chargeId,
          reason,
          reverse_transfer: true,
          amount: amount * 100,
        },
        {
          stripeAccount: config.STRIPE_ACCOUNT_ID,
        },
      );

      const charge = await stripe.charges.retrieve(chargeId);

      const { refunded, amount_refunded } = charge;
      const refundStatus = refunded ? "FULLY_REFUNDED" : "PARTIALLY_REFUNDED";

      const [updatedRefund, updatedOrder] = await Promise.all([
        RefundHelpers.findAndUpdate({
          id: refundId,
          update: {
            status: refundStatus,
            refundedAmount: amount_refunded / 100,
          },
        }),
        OrdersHelpers.findAndUpdateOrder(orderId, {
          paymentStatus: refundStatus,
        }),
      ]);
      return SuccessResponse(res, status.OK, {
        message: "Refund initiated successfully.",
        data: {
          charge,
          refund: updatedRefund,
          order: updatedOrder,
          stripeRefund: refund,
        },
      });
    } catch (error) {
      console.log(error);
      next(error);
    }
  };

  public static delete = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const id: string = req.params.id;
      RefundHelpers.softDelete(id);
      return SuccessResponse(res, status.OK, {
        message: "Data deleted successfully.",
      });
    } catch (error) {
      next(error);
    }
  };
}
