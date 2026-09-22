import { createFacetPipeline } from "../../../utils/helpers/commonHelper";
import { Referrals } from "../../../db";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";

export class ReferralHelpers {
  public static findAll = async (query: PaginatedSearchQuery) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;
    const allFilter: any = {};
    const filter = query.filter;
    const applyFilter = [];

    if (filter?.createdAt) {
      const dateQuery = {
        createdAt: {},
      };
      if (filter?.createdAt.from) {
        dateQuery.createdAt["$gte"] = new Date(filter.createdAt.from);
      }
      if (filter?.createdAt.to) {
        dateQuery.createdAt["$lte"] = new Date(filter.createdAt.to);
      }
      applyFilter.push(dateQuery);
    }

    if (applyFilter.length) {
      allFilter["$and"] = applyFilter;
    }

    const facetPipeline = createFacetPipeline(page, skips, limit);

    return Referrals.aggregate([
      {
        $match: searchValue.length
          ? {
              $or: [
                {
                  "referredTo.name.first": {
                    $regex: searchValue,
                    $options: "i",
                  },
                },
                {
                  "referredTo.name.last": {
                    $regex: searchValue,
                    $options: "i",
                  },
                },
                {
                  "referredBy.name.first": {
                    $regex: searchValue,
                    $options: "i",
                  },
                },
                {
                  "referredBy.name.last": {
                    $regex: searchValue,
                    $options: "i",
                  },
                },
              ],
            }
          : {},
      },
      {
        $lookup: {
          from: "users",
          localField: "referredByRef",
          foreignField: "_id",
          as: "referredBy",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "referredToRef",
          foreignField: "_id",
          as: "referredTo",
        },
      },
      {
        $addFields: {
          referredBy: { $arrayElemAt: ["$referredBy", 0] },
          referredTo: { $arrayElemAt: ["$referredTo", 0] },
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      { $match: allFilter },
      ...facetPipeline,
    ]);
  };
}
