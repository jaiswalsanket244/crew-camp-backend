import {
  ObjectId,
  createFacetPipeline,
} from "../../utils/helpers/commonHelper";
import { FcmTokens } from "../../db";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
import { FcmTokenType } from "../../utils/interfaces/schemaInterface";

export class FcmTokensHelpers {
  public static findAll = async (query: PaginatedSearchQuery) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;

    const facetPipeline = createFacetPipeline(page, skips, limit);

    return FcmTokens.aggregate([
      {
        $match: {
          isDeleted: false,
        },
      },
      ...facetPipeline,
    ]);
  };

  public static findOne = async (id: string) => {
    return FcmTokens.findById(id);
  };

  public static findtoken = async (id: string, token: string) => {
    return FcmTokens.find({
      userId: ObjectId(id),
      token,
      isDeleted: false,
    });
  };

  public static create = async (userId, token) => {
    await FcmTokens.deleteOne({ userId: { $ne: userId }, token });
    return FcmTokens.findOneAndUpdate(
      { token },
      { $set: { userId } },
      { upsert: true },
    );
  };

  public static getUserTokens = async (id: string) => {
    return FcmTokens.find({ userId: id, isDeleted: false });
  };

  public static findAndUpdate = async ({
    id,
    update,
  }: {
    id: string;
    update: FcmTokenType;
  }) => {
    return FcmTokens.findByIdAndUpdate(id, update);
  };

  public static deleteToken = async (token: string, userId: string) => {
    return FcmTokens.deleteOne({
      $and: [{ token }, { userId }],
    });
  };
}
