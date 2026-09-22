import * as express from "express";
import * as status from "http-status";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { SubscriptionHelpers } from "./helpers";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { stripeService } from "../../services/stripeService";
import {
  capitalize,
  convertTime,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import { SUBSCRIPTION_EVENTS } from "../../utils/enums/enums";
import { EmailService } from "../../services/email";
import { config } from "../../utils/configuration/config";
import { UserHelper } from "../user/helper";
import { Validator } from "node-input-validator";
import { subscriptionPlanUsers } from "../../utils/constants/constants";
import { PurchaseUserData } from "../../utils/interfaces/subscription";

// Drops undefined/null/empty-string fields so the thank-you page never pushes
// blank user_data values to Meta (blanks lower match quality).
const stripEmptyUserData = (data: PurchaseUserData): PurchaseUserData => {
  const result: PurchaseUserData = {};
  (Object.keys(data) as (keyof PurchaseUserData)[]).forEach((key) => {
    const value = data[key];
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
  });
  return result;
};
import { CompanyHelpers } from "../company/helpers";
export class SubscriptionRoutes {
  public static getHistory = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const response = await SubscriptionHelpers.getLogs(req.user._id);
      const red = [
        SUBSCRIPTION_EVENTS.CANCELLATION,
        SUBSCRIPTION_EVENTS.EXPIRATION,
      ];
      const data = response.map((d: any) => {
        const obj = {
          ...d,
          time: convertTime(d.time, true),
          plan: d.product_id?.split("_")?.[0] + " Plan",
          color: red.includes(d.type) ? "red" : "green",
          price: red.includes(d.type) ? undefined : d.price,
        };
        return obj;
      });
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };
  public static getAllStripeSubscripitonPlans = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await SubscriptionHelpers.findAllSubscriptionPlans();

      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };
  public static getUserPlans = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const userId = req.user._id;
    try {
      const plans = await SubscriptionHelpers.findUserPlans(userId);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: plans,
      });
    } catch (error) {
      next(
        ErrorResponse(res, error.statusCode, {
          message: error.message,
        }),
      );
    }
  };

  public static createStripeCustomer = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const user = req.user;
      const data = await SubscriptionHelpers.createStripeCustomer(user);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static createSubscription = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { priceId } = req.body;
      const user = req.user;

      if (!priceId || !user) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Price ID or user is not specified!",
        });
      }

      // Checking if stripe customer Id is created or not => If not then create one
      const userData = await SubscriptionHelpers.createStripeCustomer(user);
      const stripeCustomerId = userData.stripeCustomerId;

      // Fetch and delete existing subscriptions (if any)
      await stripeService.fetchAndDeleteExistingSubscriptions(stripeCustomerId);

      // Create new subscription
      const { subscriptionId, clientSecret } =
        await stripeService.createNewSubscription(stripeCustomerId, priceId);

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: {
          stripeCustomerId,
          subscriptionId,
          clientSecret,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static cancelSubscription = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const user = req.user;

    try {
      const admin = await CompanyHelpers.getCompanyAdminId(
        user?.companies?.[0]?.companyId,
      );

      if (admin?.userId.equals(user._id)) {
        const adminUser = await UserHelper.findOne({ _id: admin.userId });
        const subscriptionStatus = await stripeService.getSubscriptionStatus(
          adminUser.stripeCustomerId,
          true,
        );

        if (!subscriptionStatus) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "No active subscription",
          });
        }

        try {
          await stripeService.cancelSubscription(
            subscriptionStatus.subscriptionId,
          );
        } catch (error) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: error.message,
          });
        }
      }
      return SuccessResponse(res, status.OK, {
        message: "Subscription cancelled successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static upgradeSubscription = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const user = req.user;
    try {
      const validator = new Validator(req.body, {
        productId: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const admin = await CompanyHelpers.getCompanyAdminId(
        user?.companies?.[0]?.companyId,
      );

      if (admin?.userId.equals(user._id)) {
        const adminUser = await UserHelper.findOne({ _id: admin.userId });
        const subscriptionStatus = await stripeService.getSubscriptionStatus(
          adminUser.stripeCustomerId,
          true,
        );

        if (!subscriptionStatus) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "No active subscription",
          });
        }
        const product = await stripeService.getProductData(req.body.productId);

        try {
          await stripeService.upgradeSubscription(
            subscriptionStatus.subscriptionId,
            product.default_price,
          );
        } catch (error) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: error.message,
          });
        }
      }
      return SuccessResponse(res, status.OK, {
        message: "Subscription Upgraded successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static downgradeSubscription = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const user = req.user;
    try {
      const validator = new Validator(req.body, {
        productId: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const admin = await CompanyHelpers.getCompanyAdminId(
        user?.companies?.[0]?.companyId,
      );

      if (admin?.userId.equals(user._id)) {
        const adminUser = await UserHelper.findOne({ _id: admin.userId });
        const subscriptionStatus = await stripeService.getSubscriptionStatus(
          adminUser.stripeCustomerId,
          true,
        );

        if (!subscriptionStatus) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "No active subscription",
          });
        }
        const product = await stripeService.getProductData(req.body.productId);

        try {
          await stripeService.upgradeSubscription(
            subscriptionStatus.subscriptionId,
            product.default_price,
          );
        } catch (error) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: error.message,
          });
        }
      }
      return SuccessResponse(res, status.OK, {
        message: "Subscription downgraded successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getStripeProducts = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const response = await stripeService.getProductList();
      const viewablePlans = await stripeService.getUserViewablePlans();

      const data = new Array(8);

      for (const plan of response) {
        const planSplitName = plan.name.split("_");
        const planIndex = viewablePlans?.indexOf(planSplitName[1]);
        if (planIndex == -1) continue;

        const planName = planSplitName[0];

        data[planIndex] = {
          id: plan.id,
          name: capitalize(planName) + " Plan",
          members: subscriptionPlanUsers(planName),
          price: plan.name.split("_").at(-1),
        };
      }

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data: data.filter((plan) => !!plan),
      });
    } catch (error) {
      next(error);
    }
  };

  public static createPaymentLink = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        productId: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { productId, isOneTimePayment } = req.body;
      const user = req.user;

      let stripeCustomerId;

      if (user.stripeCustomerId) {
        stripeCustomerId = user.stripeCustomerId;
      } else {
        const response = await stripeService.findUserByEmail(user.email);
        if (response) {
          stripeCustomerId = response;
        } else {
          const newCustomer = await stripeService.createStripeCustomer(
            `${user.name.first} ${user.name.last}`,
            user.email,
          );
          stripeCustomerId = newCustomer.id;
        }

        await UserHelper.findByIdAndUpdate(user._id, { stripeCustomerId });
      }

      const product = await stripeService.getProductData(productId);

      const paymentLink = await stripeService.createPaymentLink(
        product.default_price,
        stripeCustomerId,
        isOneTimePayment,
        user._id,
      );

      const emailService = new EmailService();
      await emailService.sendgridTemplate(
        {
          link: paymentLink,
        },
        user.email,
        config.SENDGRID_PAYMENTLINk_TEMPLATE,
      );

      return SuccessResponse(res, status.OK, {
        message: "Payment link sent successfully.",
        data: { paymentLink },
      });
    } catch (error) {
      next(error);
    }
  };

  public static success = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { successId, session_id } = req.query;

      if (successId) {
        const success = await SubscriptionHelpers.getTeamLimitOnSucess(
          ObjectId(successId),
        );
        if (success) {
          await SubscriptionHelpers.updateCompanyTeamSize(
            success.companyId,
            success.teamLimit,
          );
        }
      }

      // Forward the Stripe session id to the web app's thank-you page so it can
      // fetch purchase details and fire the conversion event. Falls back to the
      // plain subscription page when no session id is present.
      const redirectUrl = session_id
        ? `${config.APP_URL}/subscription/success?session_id=${session_id}`
        : `${config.APP_URL}/subscription`;

      return res.redirect(redirectUrl);
    } catch (error) {
      next(error);
    }
  };

  public static getSessionDetails = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        sessionId: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { sessionId } = req.params;
      const session = await stripeService.getCheckoutSession(sessionId);

      // Ensure the session belongs to the requesting user before exposing details.
      if (!session || session.customer !== req.user.stripeCustomerId) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Session not found.",
        });
      }

      const lineItems = session.line_items?.data ?? [];

      const user_data = stripEmptyUserData({
        email: req.user.email ?? session.customer_details?.email ?? undefined,
        phone: req.user.phone ?? session.customer_details?.phone ?? undefined,
        first_name: req.user.name?.first ?? undefined,
        last_name: req.user.name?.last ?? undefined,
      });

      const data = {
        transaction_id:
          session.subscription || session.payment_intent || session.id,
        value: (session.amount_total ?? 0) / 100,
        currency: (session.currency ?? "usd").toUpperCase(),
        items: lineItems.map((item) => ({
          item_id: item.price?.id,
          item_name: item.description,
          quantity: item.quantity,
          price: (item.amount_total ?? 0) / 100,
        })),
        // Stable internal user id — Meta uses external_id as an extra match signal.
        external_id: String(req.user._id),
        user_data,
      };

      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };

  // Opens the Stripe Billing Portal for the company's subscription owner (admin).
  // Stripe handles all subscription/payment changes; the portal returns the
  // customer to the web app's subscription page.
  public static createBillingPortalSession = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const user = req.user;
    try {
      const admin = await CompanyHelpers.getCompanyAdminId(
        user?.companies?.[0]?.companyId,
      );

      if (!admin?.userId.equals(user._id)) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Only the company admin can manage billing.",
        });
      }

      const adminUser = await UserHelper.findOne({ _id: admin.userId });
      const stripeCustomerId = adminUser?.stripeCustomerId;

      if (!stripeCustomerId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No billing account found for this company.",
        });
      }

      const session = await stripeService.createBillingPortalSession(
        stripeCustomerId,
        `${config.APP_URL}/subscription`,
      );

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: { url: session.url },
      });
    } catch (error) {
      next(error);
    }
  };
}
