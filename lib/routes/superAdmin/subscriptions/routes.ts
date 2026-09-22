// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { SubscriptionHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../../utils/helpers/apiResponse";
import {
  STRIPE_SUBSCRIPTION_PLANS_PERIOD,
  SUBSCRIPTION_STORES_ENUM,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTIONS,
} from "../../../utils/enums/enums";
import { ObjectId, getDate } from "../../../utils/helpers/commonHelper";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { UserHelper } from "../../user/helper";
import { stripeService } from "../../../services/stripeService";
import { Validator } from "node-input-validator";
import { EmailService } from "../../../services/email";
import { CompanyHelpers } from "../../company/helpers";
import { config } from "../../../utils/configuration/config";
import { subscriptionPlanUsers } from "../../../utils/constants/constants";
import { isValidObjectId } from "mongoose";

export class SubscriptionRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const response = await SubscriptionHelpers.activeSubscriptionCount();
      const data = { total: 0 };

      SUBSCRIPTIONS.map((s) => (data[s] = 0));

      response.map((r) => {
        data[r._id] = r.total;
        data.total += r.total;
      });

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getSubscriptionData = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery = req.query;

      query.page = Number(query.page) || 1;
      query.limit = Number(query.limit) || 10;
      query.skips = (query.page - 1) * query.limit;
      query.searchValue = query.searchValue || "";
      let data = {
        data: [],
        page: query.page,
        totalPages: query.page,
        count: 0,
      };

      const companys = await SubscriptionHelpers.getAdmins();

      if (companys.length) {
        const adminIds = companys.map((u) => u.userId);
        const [response, count] =
          await SubscriptionHelpers.getAdminSubscriptionData(adminIds, query);

        const op = await Promise.all(
          response.map(async (user) => {
            const company = await CompanyHelpers.getMyCompanies(user._id);

            const [companyMembers, admin] = await Promise.all([
              CompanyHelpers.getCompanyMembers(company.map((c) => c.companyId)),
              CompanyHelpers.getCompanyAdminId(company[0].companyId),
            ]);

            let teamLimit = 2;

            if (user.subscriptionStatus == SUBSCRIPTION_STATUS.ACTIVE) {
              if (
                user.subscriptionBoughtFrom ==
                  SUBSCRIPTION_STORES_ENUM.STRIPE &&
                admin?.teamLimit
              ) {
                teamLimit = admin.teamLimit;
              } else {
                teamLimit = subscriptionPlanUsers(
                  user?.subscriptionPlan?.split("_")?.[0],
                );
              }
            }

            return {
              ...user,
              teamLimit,
              teamSize: companyMembers.length,
              createdAt: getDate(user.createdAt),
              subscriptionActiveUntil: user.subscriptionActiveUntil
                ? getDate(user.subscriptionActiveUntil)
                : "NA",
              planType: user?.subscriptionPlan?.split("_")?.[0],
            };
          }),
        );

        data = {
          data: op,
          page: query.page,
          totalPages: Math.ceil(count / query.limit),
          count,
        };
      }

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateTeamLimit = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        userId: "required",
        teamLimit: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { userId, teamLimit } = req.body;

      if (userId && isValidObjectId(userId) && teamLimit && Number(teamLimit)) {
        const user = await UserHelper.findOne({ _id: ObjectId(userId) });

        if (
          user.subscriptionBoughtFrom == SUBSCRIPTION_STORES_ENUM.STRIPE &&
          user.subscriptionStatus == SUBSCRIPTION_STATUS.ACTIVE
        ) {
          await CompanyHelpers.updateTeamLimitByUserId(user._id, teamLimit);
        }
      }

      return SuccessResponse(res, status.OK, {
        message: "Team limit updated  successfully.",
        data: { teamLimit },
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

      const data = response.map((plan) => {
        return {
          id: plan.id,
          name: plan.name.split("_")[0],
          description: plan.description,
          price: plan.name.split("_").at(-1),
        };
      });

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
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
        userId: "required",
        productId: "required",
        price: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { userId, productId, price, isOneTimePayment, teamLimit } =
        req.body;

      const [user, companies] = await Promise.all([
        UserHelper.findOne({ _id: ObjectId(userId) }),
        CompanyHelpers.getMyCompanies(ObjectId(userId)),
      ]);
      if (!user) return next("User not found");

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

      const payment = await stripeService.createPrice(
        productId,
        stripeCustomerId,
        Number(price),
        product?.metadata?.reccuringInterval ||
          STRIPE_SUBSCRIPTION_PLANS_PERIOD.month,
      );

      let successId;
      if (teamLimit && companies.length) {
        const success = await SubscriptionHelpers.updateTeamLimitOnSucess(
          companies?.[0]?.companyId,
          teamLimit,
        );
        successId = success._id;
      }

      const paymentLink = await stripeService.createPaymentLink(
        payment.id,
        stripeCustomerId,
        isOneTimePayment,
        successId,
      );

      return SuccessResponse(res, status.OK, {
        message: "Payment link created successfully.",
        data: { paymentLink },
      });
    } catch (error) {
      next(error);
    }
  };

  public static sharePaymentLink = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        userId: "required",
        paymentLink: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { userId, paymentLink } = req.body;

      const user = await UserHelper.findOne({ _id: ObjectId(userId) });
      if (!user) return next("User not found");

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
      });
    } catch (error) {
      next(error);
    }
  };
}
