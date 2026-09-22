import { ObjectId } from "../../utils/helpers/commonHelper";
import { Referrals } from "../../db";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
export class ReferralHelpers {
  public static findAll = async (query: PaginatedSearchQuery) => {
    const { referredBy } = query;
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
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

    return Referrals.aggregate([
      {
        $match: { referredByRef: ObjectId(referredBy) },
      },
      {
        $lookup: {
          from: "users",
          localField: "referredToRef",
          foreignField: "_id",
          as: "referredTo",
        },
      },
      { $match: allFilter },
      {
        $unwind: {
          path: "$referredTo",
        },
      },
      {
        $addFields: {
          referredTo: {
            $concat: ["$referredTo.name.first", " ", "$referredTo.name.last"],
          },
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      },
      {
        $facet: {
          data: [
            {
              $skip: skips,
            },
            {
              $limit: limit,
            },
          ],
          count: [
            {
              $count: "count",
            },
          ],
          totalRewards: [
            {
              $group: {
                _id: null,
                totalPoints: { $sum: "$points" },
              },
            },
            {
              $project: {
                _id: 0,
                totalPoints: "$totalPoints",
              },
            },
          ],
        },
      },
    ]);
  };
}
