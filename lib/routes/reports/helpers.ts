import { Report } from "../../db";
import {
  ObjectId,
  createFacetPipeline,
  getUserNamePipeline,
} from "../../utils/helpers/commonHelper";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
import { ObjectId as mongoId } from "mongoose";
import { CURRENT_STATUS } from "../../utils/enums/enums";

export class ReportsHelpers {
  public static getReports = async (
    userId: mongoId,
    query: PaginatedSearchQuery & { searchValue?: string },
  ) => {
    const { page, skips, limit } = query;

    const facetPipeline = createFacetPipeline(page, skips, limit);

    const matchQuery = {
      userId,
    };

    const matchPipeline = [];

    if (query.searchValue && query.searchValue != "") {
      matchPipeline.push({
        $search: {
          index: "reportSearch",
          text: {
            query: query.searchValue,
            path: ["creatorName", "reason", "description"],
          },
        },
      });
    }

    matchPipeline.push({
      $match: matchQuery,
    });

    return Report.aggregate([
      ...matchPipeline,
      {
        $group: {
          _id: "$postId",
          reasons: { $addToSet: "$reason" },
          descriptions: { $addToSet: "$description" },
          createdAt: { $last: "$createdAt" },
          isOpened: { $last: "$isOpened" },
          creatorName: { $push: "$creatorName" },
        },
      },
      {
        $lookup: {
          from: "posts",
          let: { postId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$postId"] } } },
            {
              $lookup: {
                from: "postfiles",
                let: { postId: "$_id" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ["$postId", "$$postId"] },
                      status: CURRENT_STATUS.ACTIVE,
                    },
                  },
                  { $sort: { position: 1 as const, createdAt: 1 as const } },
                ],
                as: "files",
              },
            },
          ],
          as: "postData",
        },
      },
      {
        $addFields: {
          postImages: { $arrayElemAt: ["$postData.files", 0] },
        },
      },
      { $project: { postData: 0 } },
      {
        $sort: {
          isOpened: 1,
          createdAt: -1,
        },
      },
      ...facetPipeline,
    ]);
  };

  public static markAsRead = (postId: string) => {
    return Report.updateMany({ postId: ObjectId(postId) }, { isOpened: true });
  };

  public static getReportData = (postId: string) => {
    const userNamePipeline = getUserNamePipeline("createdBy");

    return Report.aggregate([
      {
        $match: {
          postId: ObjectId(postId),
        },
      },
      ...userNamePipeline,
      {
        $group: {
          _id: "$postId",
          reportReasons: {
            $push: {
              creatorName: "$creatorName",
              reason: "$reason",
              description: "$description",
              createdAt: "$createdAt",
              profileImage: "$profileImage",
              userName: "$userName",
            },
          },
        },
      },
      {
        $lookup: {
          from: "posts",
          let: { postId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$postId"] } } },
            {
              $lookup: {
                from: "postfiles",
                let: { postId: "$_id" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ["$postId", "$$postId"] },
                      status: CURRENT_STATUS.ACTIVE,
                    },
                  },
                  { $sort: { position: 1 as const, createdAt: 1 as const } },
                ],
                as: "files",
              },
            },
          ],
          as: "post",
        },
      },
      {
        $project: {
          reportReasons: 1,
          files: {
            $arrayElemAt: ["$post.files", 0],
          },
          note: {
            $arrayElemAt: ["$post.note", 0],
          },
          projectId: {
            $arrayElemAt: ["$post.projectId", 0],
          },
          createdAt: {
            $arrayElemAt: ["$post.createdAt", 0],
          },
          postedBy: {
            $arrayElemAt: ["$post.userId", 0],
          },
        },
      },
      ...getUserNamePipeline("postedBy"),
      {
        $lookup: {
          from: "projects",
          localField: "projectId",
          foreignField: "_id",
          as: "project",
        },
      },
      {
        $addFields: {
          project: {
            $arrayElemAt: ["$project.name", 0],
          },
        },
      },
      {
        $project: {
          userInfo: 0,
          postedBy: 0,
        },
      },
    ]);
  };

  public static deleteReport = (postId: string) => {
    return Report.deleteMany({ postId: ObjectId(postId) });
  };

  public static markAllAsRead = (userId: mongoId) => {
    return Report.updateMany({ userId, isOpened: false }, { isOpened: true });
  };
}
