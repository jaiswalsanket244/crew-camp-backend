import {
  Company,
  RevenueCatlogs,
  StripePostPayment,
  Subscription,
} from "../../db";
import { createFacetPipeline } from "../../utils/helpers/commonHelper";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
import {
  SubscriptionType,
  ObjectIdType,
} from "../../utils/interfaces/schemaInterface";
import { stripeService } from "../../services/stripeService";
import { config } from "../../utils/configuration/config";
import { ObjectId } from "mongoose";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")(config.STRIPE_SECRET_KEY);
export class SubscriptionHelpers {
  public static findAllSubscriptionPlans = async () => {
    const products = await stripe.products.list({ limit: 3 });

    // Fetch plans for each product
    const productsWithPlans = await Promise.all(
      products.data.map(async (product) => {
        const plans = await stripe.plans.list({
          product: product.id,
          limit: 10,
        });
        return { ...product, plans: plans.data };
      }),
    );

    return productsWithPlans;
  };

  public static findAll = async (query: PaginatedSearchQuery) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;
    const allFilter: any = {};
    const filter = query.filter;
    const applyFilter = [];

    if (filter?.type) {
      applyFilter.push({ "subscriptionPlan.type": filter.type });
    }
    if (filter?.status) {
      applyFilter.push({ status: filter.status });
    }
    if (filter?.price) {
      const priceQuery = numberQuery(filter.price, "subscriptionPlan.type");
      priceQuery && applyFilter.push(priceQuery);
    }

    if (filter?.subscriptionStartDate) {
      const dateQuery = {
        currentPeriodStarts: {},
      };
      if (filter?.subscriptionStartDate.from) {
        dateQuery.currentPeriodStarts["$gte"] = Math.floor(
          new Date(filter.subscriptionStartDate.from).getTime() / 1000,
        );
      }
      if (filter?.subscriptionStartDate.to) {
        dateQuery.currentPeriodStarts["$lte"] = Math.floor(
          new Date(filter.subscriptionStartDate.to).getTime() / 1000,
        );
      }
      applyFilter.push(dateQuery);
    }

    if (filter?.subscriptionEndDate) {
      const dateQuery = {
        currentPeriodEnds: {},
      };
      if (filter?.subscriptionEndDate.from) {
        dateQuery.currentPeriodEnds["$gte"] = Math.floor(
          new Date(filter.subscriptionEndDate.from).getTime() / 1000,
        );
      }
      if (filter?.subscriptionEndDate.to) {
        dateQuery.currentPeriodEnds["$lte"] = Math.floor(
          new Date(filter.subscriptionEndDate.to).getTime() / 1000,
        );
      }
      applyFilter.push(dateQuery);
    }

    if (applyFilter.length) {
      allFilter["$and"] = applyFilter;
    }

    const facetPipeline = createFacetPipeline(page, skips, limit);

    const searchQuery = searchValue.length
      ? {
          $or: [
            { "user.name.first": { $regex: searchValue, $options: "i" } },
            { "user.name.last": { $regex: searchValue, $options: "i" } },
            { "subscriptionPlan.name": { $regex: searchValue, $options: "i" } },
          ],
        }
      : {};

    return Subscription.aggregate([
      {
        $lookup: {
          from: "users",
          localField: "userRef",
          foreignField: "_id",
          as: "user",
        },
      },
      {
        $lookup: {
          from: "subscriptionplans",
          localField: "subscriptionPlanRef",
          foreignField: "_id",
          as: "subscriptionPlan",
        },
      },
      { $match: allFilter.length ? { $and: allFilter } : {} },
      {
        $addFields: {
          user: { $arrayElemAt: ["$user", 0] },
        },
      },
      {
        $addFields: {
          subscriptionPlan: { $arrayElemAt: ["$subscriptionPlan", 0] },
        },
      },
      { $match: searchQuery },
      ...facetPipeline,
    ]);
  };

  public static findUserPlans = async (userId: ObjectIdType) => {
    return Subscription.find({
      $and: [{ userRef: userId }, { status: "ACTIVE" }],
    });
  };

  public static createSubscription = async (document: SubscriptionType) => {
    return Subscription.create(document);
  };

  public static createStripeCustomer = async (user) => {
    if (user.stripeCustomerId) {
      return user;
    }

    const newCustomer = await stripeService.createStripeCustomer(
      user.fullName,
      user.email,
    );
    user.stripeCustomerId = newCustomer.id;
    await user.save();
    return user;
  };

  public static getLogs = (userId: ObjectId) => {
    return RevenueCatlogs.find({ userId }, { event: 0 })
      .sort({ createdAt: -1 })
      .lean();
  };

  public static getTeamLimitOnSucess = (successId: ObjectIdType) => {
    return StripePostPayment.findById(successId);
  };

  public static updateCompanyTeamSize = (
    companyId: ObjectIdType,
    teamLimit: number,
  ) => {
    return Company.findByIdAndUpdate(companyId, { $set: { teamLimit } });
  };
}

const numberQuery = (filter: any, key: string) => {
  if (filter?.min && filter?.max) {
    const numberQuery = {
      [key]: {
        $gte: parseInt(filter.min),
        $lte: parseInt(filter.max),
      },
    };
    return numberQuery;
  }
};
