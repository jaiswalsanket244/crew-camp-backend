import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { ActivityLogs, User } from "../../../db";
import { Types } from "mongoose";

export interface UserLogs {
  month: number;
}
export class UsersHelpers {
  public static findAll = async (query: PaginatedSearchQuery) => {
    const matchQuery = {
      $or: [
        { username: { $regex: query.searchValue, $options: "i" } },
        { email: { $regex: query.searchValue, $options: "i" } },
      ],
    };
    return Promise.all([
      User.aggregate([
        {
          $match: matchQuery,
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
  public static findOne = async (id: Types.ObjectId) => {
    return User.findById(id);
  };

  public static getActiveUserGraph = (year: number) => {
    return ActivityLogs.aggregate([
      {
        $match: {
          year,
        },
      },
      {
        $group: {
          _id: "$month",
          total: {
            $sum: 1,
          },
        },
      },
    ]);
  };

  public static getLastActive = (userId: Types.ObjectId) => {
    return ActivityLogs.find({
      userId,
    })
      .sort({ createdAt: -1 })
      .limit(1);
  };

  public static create = (userData) => {
    return User.create(userData);
  };
}
