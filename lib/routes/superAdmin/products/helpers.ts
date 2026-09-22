import { createFacetPipeline } from "../../../utils/helpers/commonHelper";
import { Products } from "../../../db";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";

export class ProductsHelpers {
  public static findOne = async (id: string) => {
    return Products.findById(id);
  };

  public static findAll = async (query: PaginatedSearchQuery) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;
    const allFilter: any = {};
    const filter = query.filter;
    const applyFilter = [];

    if (filter && Object.keys(filter).length) {
      const searchFilter = ["name"];
      searchFilter.forEach((key) => {
        if (filter[key]) {
          const data = {
            [key]: filter[key],
          };
          applyFilter.push(data);
        }
      });
    }

    if (filter?.price) {
      const query = numberQuery(filter.price, "price");
      query ? applyFilter.push(query) : null;
    }

    if (applyFilter.length) {
      allFilter.$and = applyFilter;
    }
    if (filter?.category?.length) {
      allFilter.category = {
        $in: filter.category,
      };
    }

    const facetPipeline = createFacetPipeline(page, skips, limit);
    return Products.aggregate([
      { $match: searchValue.length ? { $text: { $search: searchValue } } : {} },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "seller",
        },
      },
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "productId",
          as: "ordersCount",
        },
      },
      {
        $addFields: {
          ordersCount: {
            $size: "$ordersCount",
          },
        },
      },
      { $unwind: { path: "$seller" } },
      { $match: allFilter },
      ...facetPipeline,
    ]);
  };

  public static findAndUpdate = async ({ id, update }) => {
    return Products.findByIdAndUpdate(id, update);
  };

  public static create = async (document) => {
    return Products.create(document);
  };

  public static softDelete = async (id) => {
    await Products.findByIdAndUpdate(id, { status: "DELETED" });
    return { del: "ok" };
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
