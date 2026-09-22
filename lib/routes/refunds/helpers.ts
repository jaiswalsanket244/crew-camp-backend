import { Refund } from "../../db";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";

import {
  ObjectId,
  createFacetPipeline,
} from "../../utils/helpers/commonHelper";
import * as dayjs from "dayjs";

export class RefundHelpers {
  public static findOne = async (id: string) => {
    return Refund.findOne({ _id: id });
  };

  public static getAllRefunds = async (
    query: PaginatedSearchQuery,
    userId: string,
  ) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;
    const matchObj: any = { user: ObjectId(userId) };

    if (searchValue) {
      matchObj.$text = { $search: searchValue };
    }

    const facetPipeline = createFacetPipeline(page, skips, limit);

    const data = await Refund.aggregate([
      { $match: matchObj },
      { $sort: { createdAt: -1 } },
      ...facetPipeline,
    ]);
    const processedData = data[0].data.map((item) => {
      item.amount = Number((item.amount / 100).toFixed(2));
      item.formattedTime = dayjs(item.createdAt).format(
        "MMMM Do YYYY, h:mm:ss a",
      );
      return item;
    });

    data[0].data = processedData;

    return data;
  };

  public static create = async (document: any) => {
    return Refund.create(document);
  };

  public static findAndUpdate = async ({ id, update }) => {
    return Refund.findByIdAndUpdate(id, update);
  };
}
