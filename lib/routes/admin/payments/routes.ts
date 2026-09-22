import * as status from "http-status";
import * as express from "express";
import * as StandardError from "standard-error";
import { PaymentHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import { stripeService } from "../../../services/stripeService";
import { EmailService } from "../../../services/email";
import { SuccessResponse } from "../../../utils/helpers/apiResponse";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
export class PaymentRoutes {
  public static getAllPayments = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery = req.query;
      const data = await PaymentHelpers.getAllPayments(query);
      return SuccessResponse(res, status.OK, {
        success: true,
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static createRefundForCharge = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const refundData = req.body;
      const payment = await PaymentHelpers.getPaymentById(refundData._id);
      const refundObj: { charge: string; amount: number; reason?: string } = {
        charge: payment.chargeId,
        amount: refundData.amount,
      };
      if (refundData.reason) {
        refundObj.reason = refundData.reason;
      }
      const refundResponse =
        await stripeService.createRefundForCharge(refundObj);
      refundResponse.paymentId = refundData._id;
      refundResponse.user = payment.user;
      const data = await PaymentHelpers.createRefund(refundResponse);

      const emailService = new EmailService();
      emailService.refundEmail({
        email: payment.email,
        amount: Number((refundResponse.amount / 100).toFixed(2)),
        currency: refundResponse.currency,
        status: refundResponse.status,
      });

      return SuccessResponse(res, status.OK, {
        message: "Refund created successfully.",
        data,
      });
    } catch (error) {
      if (error.message) {
        const errorObj = {
          message: error.raw.message,
          code: error.raw.statusCode,
        };
        next(errorObj);
      }
      next(error);
    }
  };

  public static getAllCharges = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { stripeAccountId }: { stripeAccountId: string } = req.user;
      const chargesPromise = PaymentHelpers.getSellerCharges(
        stripeAccountId,
        req.query,
      );
      const balancePromise =
        PaymentHelpers.getSellerStripeBalance(stripeAccountId);
      const [charges, balance] = await Promise.all([
        chargesPromise,
        balancePromise,
      ]);
      return SuccessResponse(res, status.OK, {
        message: "Charges retrieved successfully.",
        data: { charges, balance },
      });
    } catch (error) {
      next(
        new StandardError({ message: error.message, code: error.statusCode }),
      );
    }
  };

  public static getAllPayouts = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { stripeAccountId } = req.user;
      const payoutsPromise = PaymentHelpers.getSellerPayouts(
        stripeAccountId,
        req.query,
      );
      const balancePromise =
        PaymentHelpers.getSellerStripeBalance(stripeAccountId);
      const [payouts, balance] = await Promise.all([
        payoutsPromise,
        balancePromise,
      ]);
      return SuccessResponse(res, status.OK, {
        message: "Payouts retrieved successfully.",
        data: { payouts, balance },
      });
    } catch (error) {
      next(
        new StandardError({ message: error.message, code: error.statusCode }),
      );
    }
  };

  public static createPayout = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const body = req.body;
      const amount = body.amount;
      const user = req.user;
      const data = await PaymentHelpers.createPayout(
        amount,
        user.stripeAccountId,
      );
      return SuccessResponse(res, status.OK, {
        message: "Payouts created successfully.",
        data,
      });
    } catch (error) {
      next(
        new StandardError({ message: error.message, code: error.statusCode }),
      );
    }
  };
}
