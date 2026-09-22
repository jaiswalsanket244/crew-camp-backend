import * as status from "http-status";
import * as express from "express";

import { RefundHelpers } from "./helpers";
import { OrdersHelpers } from "../orders/helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { SuccessResponse } from "../../utils/helpers/apiResponse";

export class RefundRoutes {
  public static getAllPayments = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const userId = req.user._id;
      const data = await RefundHelpers.getAllRefunds(req.query, userId);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
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
      const document = req.body;
      const createRefund = {
        refundedAmount: 0,
        orderRef: document.orderRef,
      };

      const [data, updateOrder] = await Promise.all([
        RefundHelpers.create(createRefund),
        OrdersHelpers.findAndUpdateOrder(document.orderRef, {
          paymentStatus: "PENDING_REFUND",
        }),
      ]);

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: { data, updateOrder },
      });
    } catch (error) {
      next(error);
    }
  };
}
