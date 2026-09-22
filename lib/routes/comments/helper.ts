import { ObjectId as mongoId } from "mongoose";
import { Comments, PostFiles } from "../../db";
import { isValidObjectId, ObjectId } from "../../utils/helpers/commonHelper";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
import {
  CommentType,
  ObjectIdType,
} from "../../utils/interfaces/schemaInterface";
import { CURRENT_STATUS } from "../../utils/enums/enums";

type commentQueryType = {
  projectId?: string;
  postId?: string;
  fileId?: string;
  commentId?: string;
  projectNoteId?: string;
};

export class CommentHelper {
  public static create = async (body: CommentType) => {
    const comment = await Comments.create(body);

    // Increment commentCount in PostFiles if this is a top-level comment on a file (not a reply)
    if (body.fileId && body.postId && !body.commentId) {
      await PostFiles.findOneAndUpdate(
        { _id: body.fileId, postId: body.postId },
        { $inc: { commentCount: 1 } },
      );
    }

    return comment;
  };

  public static insertMany = async (payload: CommentType[]) => {
    return Comments.insertMany(payload);
  };

  public static update = async (id: ObjectIdType, body: CommentType) => {
    return Comments.findByIdAndUpdate(id, { $set: body });
  };

  public static findAll = async (
    queryData: commentQueryType & PaginatedSearchQuery,
    userId: mongoId,
  ) => {
    let key;

    if (queryData.projectId) key = "projectId";
    else if (queryData.postId) key = "postId";
    else if (queryData.commentId) key = "commentId";
    else if (queryData.projectNoteId) key = "projectNoteId";
    else return [];

    if (!isValidObjectId(queryData[key])) return [];

    const { page, limit, skips } = queryData;

    const matchQuery: any = {
      [key]: ObjectId(queryData[key]),
      status: "ACTIVE",
    };

    if (key === "postId") {
      matchQuery.fileId = { $exists: false };
    }

    if (queryData.fileId) {
      matchQuery.fileId = ObjectId(queryData.fileId);
    }

    const [total, items] = await Promise.all([
      Comments.countDocuments(matchQuery),
      Comments.aggregate([
        {
          $match: matchQuery,
        },
        {
          $sort: {
            createdAt: -1,
          },
        },
        { $skip: skips },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            pipeline: [
              {
                $project: {
                  "name.first": 1,
                  "name.last": 1,
                  profileImage: 1,
                },
              },
            ],
            as: "userInfo",
          },
        },
        {
          $lookup: {
            from: "comments",
            localField: "_id",
            foreignField: "commentId",
            pipeline: [
              {
                $count: "count",
              },
            ],
            as: "replyCount",
          },
        },
        {
          $lookup: {
            from: "likes",
            let: { commentId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ["$commentId", "$$commentId"],
                  },
                  isLiked: true,
                },
              },
              {
                $group: {
                  _id: null,
                  totalLikes: { $sum: 1 },
                  isLiked: {
                    $sum: {
                      $cond: [
                        {
                          $eq: ["$userId", userId],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ],
            as: "likes",
          },
        },
        {
          $project: {
            comment: 1,
            userId: 1,
            userName: {
              $concat: [
                { $arrayElemAt: ["$userInfo.name.first", 0] },
                " ",
                { $arrayElemAt: ["$userInfo.name.last", 0] },
              ],
            },
            fileUrl: 1,
            fileSize: 1,
            profileImage: {
              $arrayElemAt: ["$userInfo.profileImage", 0],
            },
            replies: {
              $ifNull: [{ $arrayElemAt: ["$replyCount.count", 0] }, 0],
            },
            createdAt: 1,
            totalLikes: {
              $ifNull: [{ $arrayElemAt: ["$likes.totalLikes", 0] }, 0],
            },
            isLiked: {
              $cond: [{ $arrayElemAt: ["$likes.isLiked", 0] }, true, false],
            },
          },
        },
      ]),
    ]);

    return [
      {
        items,
        total,
        page,
        pageSize: limit,
        totalPages: Math.ceil(total / limit),
      },
    ];
  };

  public static findById = async (id: ObjectIdType) => {
    return Comments.findById(id);
  };

  public static findAllReplies = async (commentId: ObjectIdType) => {
    return Comments.find({ commentId: commentId });
  };

  public static deleteCommentById = async (id: ObjectIdType) => {
    const comment = await Comments.findByIdAndDelete(id);

    // Decrement commentCount in PostFiles if this was a top-level comment on a file (not a reply)
    if (comment && comment.fileId && comment.postId && !comment.commentId) {
      await PostFiles.findOneAndUpdate(
        { _id: comment.fileId, postId: comment.postId },
        { $inc: { commentCount: -1 } },
      );
    }

    return comment;
  };

  public static deleteRepliesByCommentId = async (commentId: ObjectIdType) => {
    return Comments.deleteMany({ commentId: commentId });
  };

  public static deleteCommentsByFileId = async (query: any) => {
    // Find top-level comments on the file before deleting to update comment count
    const topLevelComments = await Comments.find({
      ...query,
      commentId: { $exists: false }, // Only top-level comments, not replies
    });

    // Delete all comments (including replies)
    const result = await Comments.deleteMany(query);

    // Update commentCount for the file if there were top-level comments
    if (topLevelComments.length > 0 && query.fileId && query.postId) {
      await PostFiles.findOneAndUpdate(
        { _id: query.fileId, postId: query.postId },
        { $inc: { commentCount: -topLevelComments.length } },
      );
    }

    return result;
  };

  public static getCommentsWithFiles = async (query: any) => {
    return Comments.find(
      { ...query, fileUrl: { $exists: true } },
      { fileUrl: 1 },
    );
  };

  public static getCommentsCountByProject = async (projectId: ObjectIdType) => {
    return Comments.countDocuments({
      projectId,
      status: CURRENT_STATUS.ACTIVE,
    });
  };
}
