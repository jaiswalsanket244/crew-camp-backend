import * as express from "express";
import * as status from "http-status";
import * as StandardError from "standard-error";
import { User, Payment, Products } from "./../../db/index";
import { stripeService } from "../../services/stripeService";
import { UsersHelpers } from "./helpers/user.helper";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { config } from "../../utils/configuration/config";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")(config.STRIPE_SECRET_KEY);

export class PaymentRoutes {
  public static getPayments = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const loggerInUserDetails = req.user;

    try {
      const payments = await Payment.find({ user: loggerInUserDetails._id });

      // Create an array of promises to retrieve card details in parallel
      const cardDetailPromises = payments.map(async (payment: any) => {
        if (payment.stripeCustomerId !== "0") {
          const cardDetails = await stripeService.getCardDetails(
            payment.stripeCustomerId,
            payment.cardToken,
          );
          payment["cardDetails"] = cardDetails;
        }
        return payment;
      });

      const paymentClone = await Promise.all(cardDetailPromises);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: paymentClone,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getPaymentsById = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { id }: { id: ObjectIdType } = req.params;
      const userDetails = await UsersHelpers.findOne(id);
      const payments = await Payment.find({ user: userDetails._id });
      const cardDetailPromises = payments.map(async (payment: any) => {
        if (payment.stripeCustomerId !== "0") {
          const cardDetails = await stripeService.getCardDetails(
            payment.stripeCustomerId,
            payment.cardToken,
          );
          payment["cardDetails"] = cardDetails;
        }
        return payment;
      });

      const paymentClone = await Promise.all(cardDetailPromises);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: paymentClone,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getUserCardDetails = async (
    req: AuthenticatedRequest,
    res: express.Response,
  ) => {
    const userId = req.params.userId;
    const { defaultCardToken, stripeCustomerId } = await User.findById(userId);
    if (defaultCardToken && stripeCustomerId) {
      const cardDetails = await stripeService.getCardDetails(
        stripeCustomerId,
        defaultCardToken,
      );
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: cardDetails,
      });
    } else {
      return ErrorResponse(res, status.BAD_REQUEST, {
        message: "Not a Subscribed User",
      });
    }
  };

  public static createCharge = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const loggerInUserDetails = req.user;
    const { chargeData } = req.body;
    let customer;
    let charge;
    try {
      if (!loggerInUserDetails.stripeCustomerId && chargeData.saveThisCard) {
        customer = await stripeService.createStripeCustomer(
          loggerInUserDetails.fullName,
          loggerInUserDetails.email,
        );
        await UsersHelpers.findAndUpdate(loggerInUserDetails._id, {
          $push: { cardTokens: chargeData.token.card.id },
          stripeCustomerId: customer.id,
          defaultCardToken: customer.default_source,
        });
        loggerInUserDetails.stripeCustomerId = customer.id;
        charge = await stripeService.createChargeWithSavedCard({
          loggerInUserDetails,
          chargeData,
        });
      } else if (
        loggerInUserDetails.stripeCustomerId &&
        chargeData.saveThisCard
      ) {
        const source = await stripeService.createSource({
          loggerInUserDetails,
          chargeData,
        });
        await UsersHelpers.findAndUpdate(
          loggerInUserDetails._id,
          { $push: { cardTokens: source.id } },
          { new: true },
        );
        charge = await stripeService.createChargeWithSource({
          loggerInUserDetails,
          chargeData,
          source,
        });
      } else {
        charge = await stripeService.createChargeWithOutSavedCard(chargeData);
      }

      const payment = await stripeService.createPayment({
        loggerInUserDetails,
        charge,
      });
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: payment,
      });
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };

  public static changeSavedCard = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { customer_id, card_token, _id } = req.body;
      const newCard = await stripeService.addNewCard({
        customer_id,
        card_token,
      });
      if (newCard) {
        const customer = await stripeService.updateDefaultCard({
          customer_id,
          card_id: newCard.id,
        });
        if (customer) {
          const updatedUser = await UsersHelpers.findAndUpdate(_id, {
            $addToSet: { cardTokens: newCard.id },
            defaultCardToken: newCard.id,
          });
          return SuccessResponse(res, status.OK, {
            message: "Success.",
            data: updatedUser,
          });
        }
      }
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };

  public static retrieveSavedCard = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const loggerInUserDetails = req.user;
    try {
      if (loggerInUserDetails && loggerInUserDetails.stripeCustomerId) {
        const cardList = await stripeService.listAllCards(loggerInUserDetails);
        if (cardList && cardList.data && cardList.data.length > 0) {
          return SuccessResponse(res, status.OK, {
            message: "Success.",
            data: cardList.data,
          });
        } else {
          return SuccessResponse(res, status.OK, { message: "Success." });
        }
      } else {
        return SuccessResponse(res, status.OK, { message: "Success." });
      }
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };

  public static updateCard = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const loggerInUserDetails = req.user;
    const { chargeData } = req.body;
    try {
      const confirmation = await stripeService.updateCard({
        loggerInUserDetails,
        chargeData,
      });
      if (confirmation) {
        const updatedUser = await UsersHelpers.findOne(loggerInUserDetails._id);
        return SuccessResponse(res, status.OK, {
          message: "Success.",
          data: updatedUser,
        });
      }
    } catch (error) {
      next(ErrorResponse(res, error.statusCode, { message: error.message }));
    }
  };

  public static chargeSavedCard = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const loggerInUserDetails = req.user;
      const chargeData = req.body.chargeData;
      const charge = await stripeService.createChargeWithSavedCard({
        loggerInUserDetails,
        chargeData,
      });
      const payment = await stripeService.createPayment({
        loggerInUserDetails,
        charge,
      });
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: payment,
      });
    } catch (error) {
      next(
        new StandardError({ message: error.message, code: error.statusCode }),
      );
    }
  };

  public static chargeGuestCard = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { chargeData } = req.body;
      const charge =
        await stripeService.createChargeWithOutSavedCard(chargeData);
      const loggerInUserDetails = { email: chargeData.email };
      const payment = await stripeService.createPayment({
        loggerInUserDetails,
        charge,
      });
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: payment,
      });
    } catch (error) {
      next(
        new StandardError({ message: error.message, code: error.statusCode }),
      );
    }
  };

  public static savePayPalPayment = async (
    req: AuthenticatedRequest,
    res: express.Response,
  ) => {
    const loggerInUserDetails = req.user;
    const payPalData = req.body.paypalResponse;
    const payment = await Payment.create({
      amount: payPalData.transactions[0].amount.total,
      status: payPalData.state,
      stripeCustomerId: 0,
      chargeId: 0,
      paypalPayerId: payPalData.payer.payer_info.payer_id,
      user: loggerInUserDetails._id || null,
      transactionId: payPalData.id,
      email: payPalData.payer.payer_info.email,
      currency: payPalData.transactions[0].amount.currency,
      gateWay: "paypal",
    });
    return SuccessResponse(res, status.OK, {
      message: "Success.",
      data: payment,
    });
  };

  public static saveCard = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const loggerInUserDetails = req.user;
    const { chargeData } = req.body;
    try {
      if (!loggerInUserDetails.stripeCustomerId) {
        const customer = await stripeService.createStripeCustomer(
          loggerInUserDetails.fullName,
          loggerInUserDetails.email,
        );
        const user = await UsersHelpers.findAndUpdate(
          loggerInUserDetails._id,
          {
            $push: { cardTokens: chargeData.token.card.id },
            stripeCustomerId: customer.id,
            defaultCardToken: customer.default_source,
          },
          { new: true },
        );
        return SuccessResponse(res, status.OK, {
          message: "Success.",
          data: user,
        });
      } else {
        const source = await stripeService.createSource({
          loggerInUserDetails,
          chargeData,
        });
        const user = await UsersHelpers.findAndUpdate(
          loggerInUserDetails._id,
          { $push: { cardTokens: source.id } },
          { new: true },
        );
        return SuccessResponse(res, status.OK, {
          message: "Success.",
          data: user,
        });
      }
    } catch (error) {
      next(
        new StandardError({ message: error.message, code: error.statusCode }),
      );
    }
  };

  public static deleteCard = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const loggerInUserDetails = req.user;
    const { chargeData } = req.body;
    try {
      const confirmation = await stripeService.deleteCard({
        loggerInUserDetails,
        chargeData,
      });
      if (confirmation.deleted) {
        const user = await UsersHelpers.findAndUpdate(
          loggerInUserDetails._id,
          { $pull: { cardTokens: chargeData.source } },
          { new: true },
        );
        let defaultCardToken = "";
        if (user.cardTokens && user.cardTokens.length > 0) {
          defaultCardToken = String(user.cardTokens[0]);
        }
        await UsersHelpers.findAndUpdate(
          loggerInUserDetails._id,
          { defaultCardToken },
          { new: true },
        );
        return SuccessResponse(res, status.OK, {
          message: "Success.",
          data: user,
        });
      }
    } catch (error) {
      next(
        new StandardError({ message: error.message, code: error.statusCode }),
      );
    }
  };
  public static createRefundForCharge = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { refundData } = req.body;
      const data = await stripeService.createRefundForCharge(refundData);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };

  public static createPaymentIntent = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const item = req.body;
    const user = req.user;
    const product = await Products.findOne({ _id: item._id }).populate(
      "createdBy",
    );
    const { price } = product;
    const numericPrice = Number(price);
    try {
      const params = {
        amount: numericPrice * 100,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        transfer_data: {
          amount: Math.round(((numericPrice * 80) / 100) * 100),
          // destination: seller.stripeAccountId,
        },
        description: product.description,
        shipping: {
          name: "Shyam Babu",
          address: {
            line1: "Sector 9",
            postal_code: "274301",
            city: "San Francisco",
            state: "CA",
            country: "US",
          },
        },
        metadata: {
          title: product.title,
          description: product.description,
          price: product.price,
          customerName: user.fullName,
          // sellerName: seller.fullName,
          revenue: ((numericPrice * 20) / 100) * 100,
        },
      };
      if (user.stripeCustomerId) {
        params["customer"] = user.stripeCustomerId;
      } else {
        const customer = await stripe.customers.create({
          name: user.fullName,
          address: {
            line1: "510 Townsend St",
            postal_code: "98140",
            city: "San Francisco",
            state: "CA",
            country: "US",
          },
        });
        await User.updateOne(
          { _id: user._id },
          { stripeCustomerId: customer.id },
          { new: true },
        );
        params["customer"] = customer.id;
      }

      const paymentIntent = await stripe.paymentIntents.create(params);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: paymentIntent,
      });
    } catch (error) {
      next(error);
    }
  };
}
