// Internal Dependencies
import { createFacetPipeline } from "../../../utils/helpers/commonHelper";
import { Refund } from "../../../db";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { RefundType } from "../../../utils/interfaces/schemaInterface";

export class RefundHelpers {
  public static findOne = async (id: string) => {
    return Refund.findById(id);
  };

  public static findAll = async (query: PaginatedSearchQuery) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;
    const { filter } = query;

    const matchStage = {};
    if (filter?.price) {
      const priceQuery = numberQuery(filter.price, "product.price");
      matchStage["price"] = priceQuery;
    }

    if (filter?.customer?.length) {
      matchStage["user.fullName"] = new RegExp(filter.customer, "i");
    }

    if (filter?.purchaseDate) {
      const dateQuery = {
        createdAt: {},
      };
      if (filter.purchaseDate.from) {
        dateQuery.createdAt["$gte"] = new Date(filter.purchaseDate.from);
      }
      if (filter.purchaseDate.to) {
        dateQuery.createdAt["$lte"] = new Date(filter.purchaseDate.to);
      }
      matchStage["$and"] = [dateQuery];
    }

    if (filter?.ByStatus?.length) {
      matchStage["status"] = filter.ByStatus;
    }

    if (searchValue.length) {
      matchStage["product.name"] = new RegExp(searchValue, "i");
    }

    const facetPipeline = createFacetPipeline(page, skips, limit);

    return Refund.aggregate([
      {
        $lookup: {
          from: "orders",
          localField: "orderRef",
          foreignField: "_id",
          as: "order",
        },
      },
      { $unwind: { path: "$user" } },
      {
        $lookup: {
          from: "products",
          localField: "order.productId",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product" } },
      {
        $lookup: {
          from: "users",
          localField: "order.userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user" } },
      { $match: matchStage },
      {
        $addFields: {
          "user.fullName": {
            $concat: ["$user.name.first", " ", "$user.name.last"],
          },
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      },
      ...facetPipeline,
    ]);
  };

  public static findAndUpdate = async ({
    id,
    update,
  }: {
    id: string;
    update: RefundType;
  }) => {
    return Refund.findByIdAndUpdate(id, update);
  };
  public static softDelete = async (id: string) => {
    return Refund.findByIdAndUpdate(id, { status: "COMPLETED" });
  };
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
