import { Orders } from "../../db";
import { config } from "../../utils/configuration/config";
import {
  ObjectId,
  createFacetPipeline,
} from "../../utils/helpers/commonHelper";
import { OrderType, UserType } from "../../utils/interfaces/schemaInterface";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")(config.STRIPE_SECRET_KEY);
export class OrdersHelpers {
  public static findOne = async (id: string) => {
    return Orders.findById(id).populate("productId").populate("userId");
  };

  public static findAll = async (queryParams: PaginatedSearchQuery) => {
    const page = Number(queryParams.page) || 1;
    const limit = Number(queryParams.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = queryParams.searchValue;

    const allFilter = {};
    const filter = queryParams.filter;
    const applyFilter = [];

    const addFilter = (key, value) => {
      if (value) {
        applyFilter.push({ [key]: value });
      }
    };

    // Apply filters
    addFilter("name", filter.name);
    const priceQuery = numberQuery(filter.price, "product.price");
    priceQuery && applyFilter.push(priceQuery);

    addFilter(
      "seller.fullName",
      filter.sellerName ? new RegExp(filter.sellerName, "i") : null,
    );

    // purchaseDate filter
    const dateQuery = {
      createdAt: {},
    };
    if (filter.purchaseDate) {
      dateQuery.createdAt["$gte"] = filter.purchaseDate.from
        ? new Date(filter.purchaseDate.from)
        : null;
      dateQuery.createdAt["$lte"] = filter.purchaseDate.to
        ? new Date(filter.purchaseDate.to)
        : null;
    }
    applyFilter.push(dateQuery);

    addFilter("paymentStatus", filter.ByStatus);
    addFilter(
      "product.name",
      searchValue ? new RegExp(searchValue, "i") : null,
    );

    if (filter.category?.length) {
      allFilter["category"] = { $in: filter.category };
    }

    if (applyFilter.length) {
      allFilter["$and"] = applyFilter;
    }

    const facetPipeline = createFacetPipeline(page, skips, limit);

    return Orders.aggregate([
      {
        $sort: {
          createdAt: -1,
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "productId",
          foreignField: "_id",
          as: "product",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "product.createdBy",
          foreignField: "_id",
          as: "seller",
        },
      },
      { $unwind: { path: "$seller" } },
      { $unwind: { path: "$product" } },
      {
        $addFields: {
          "seller.fullName": {
            $concat: ["$seller.name.first", " ", "$seller.name.last"],
          },
        },
      },
      { $match: allFilter },
      ...facetPipeline,
    ]);
  };

  public static findAndUpdate = async (
    id: string,
    userId: string,
    update: OrderType,
  ) => {
    return Orders.findOneAndUpdate(
      {
        $and: [{ _id: ObjectId(id), userId }],
      },
      update,
      { returnDocument: "after" },
    );
  };

  public static findAndUpdateOrder = async (
    id: string,
    update: {
      paymentStatus: string;
    },
  ) => {
    return Orders.findByIdAndUpdate(id, update, { returnDocument: "after" });
  };

  public static create = async (document: OrderType) => {
    return Orders.create(document);
  };

  public static softDelete = async (
    id: string,
    userId: string,
    user: UserType,
  ) => {
    return (
      Orders.findOneAndUpdate(
        { $and: [{ _id: ObjectId(id), userId }] },
        {
          status: "DELETED",
        },
      ).setOptions({
        deleteOperation: true,
        user,
      }),
      { returnDocument: "after" }
    );
  };

  public static async getChargeId(payment_intent: any) {
    const intent = await stripe.paymentIntents.retrieve(payment_intent);
    return intent?.latest_charge;
  }
}

const numberQuery = (filter, key) => {
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
