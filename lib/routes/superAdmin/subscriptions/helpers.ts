import { Company, StripePostPayment, User, User as users } from "../../../db";
import { CURRENT_STATUS, USER_ROLE } from "../../../utils/enums/enums";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { Types } from "mongoose";
import { ObjectIdType } from "../../../utils/interfaces/schemaInterface";

export class SubscriptionHelpers {
  public static activeSubscriptionCount = async () => {
    return users.aggregate([
      {
        $match: {
          roles: USER_ROLE.ADMIN,
        },
      },
      {
        $group: {
          _id: "$subscriptionStatus",
          total: {
            $sum: 1,
          },
        },
      },
    ]);
  };

  public static getAdminSubscriptionData = (
    userIds: Types.ObjectId[],
    query: PaginatedSearchQuery,
  ) => {
    const matchQuery = {
      _id: { $in: userIds },
      $or: [
        { phone: { $regex: query.searchValue, $options: "i" } },
        { "name.first": { $regex: query.searchValue, $options: "i" } },
        { "name.last": { $regex: query.searchValue, $options: "i" } },
        { email: { $regex: query.searchValue, $options: "i" } },
      ],
    };

    return Promise.all([
      User.aggregate([
        {
          $match: matchQuery,
        },
        {
          $lookup: {
            from: "revenuecatlogs",
            localField: "_id",
            foreignField: "userId",
            as: "revenueCatLogs",
          },
        },
        {
          $addFields: {
            productId: {
              $arrayElemAt: ["$revenueCatLogs.product_id", -1],
            },
          },
        },
        {
          $project: {
            fullName: { $concat: ["$name.first", " ", "$name.last"] },
            userRole: 1,
            email: 1,
            phone: 1,
            createdAt: 1,
            subscriptionStatus: 1,
            subscriptionActiveUntil: 1,
            subscriptionPlan: 1,
            productId: 1,
            subscriptionBoughtFrom: 1,
          },
        },
        {
          $skip: query.skips,
        },
        {
          $limit: query.limit,
        },
      ]),
      User.countDocuments(matchQuery),
    ]);
  };

  public static getAdmins = () => {
    return Company.find({ status: CURRENT_STATUS.ACTIVE }, { userId: 1 });
  };

  public static updateTeamLimitOnSucess = (
    companyId: ObjectIdType,
    teamLimit: number,
  ) => {
    return StripePostPayment.create({ companyId, teamLimit });
  };
}
