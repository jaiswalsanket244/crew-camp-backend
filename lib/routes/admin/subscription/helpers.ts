import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { Subscription } from "../../../db";
import { createFacetPipeline } from "../../../utils/helpers/commonHelper";
export class SubscriptionHelpers {
  public static findAll = async (query: PaginatedSearchQuery) => {
    const { page, pageSize, searchValue, filter } = query;
    const skips = (page - 1) * pageSize;
    const allFilter: any = {};
    const applyFilter = [];

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

    const facetPipeline = createFacetPipeline(page, skips, pageSize);

    const searchQuery = searchValue.length
      ? {
          $or: [
            { "user.name.first": { $regex: searchValue, $options: "i" } },
            { "user.name.last": { $regex: searchValue, $options: "i" } },
            { planName: { $regex: searchValue, $options: "i" } },
          ],
          status: "ACTIVE",
        }
      : { status: "ACTIVE" };

    return Subscription.aggregate([
      { $match: allFilter.length ? { $and: allFilter } : {} },
      {
        $lookup: {
          from: "users",
          localField: "userRef",
          foreignField: "_id",
          as: "user",
        },
      },
      { $match: searchQuery },
      ...facetPipeline,
    ]);
  };
}
