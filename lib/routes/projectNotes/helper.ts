import { ProjectNotesType } from "../../utils/interfaces/schemaInterface";
import { ProjectNotes } from "../../db";
import { isValidObjectId, ObjectId } from "../../utils/helpers/commonHelper";
import { CURRENT_STATUS } from "../../utils/enums/enums";

export type projectNotesQuery = {
  projectId: string;
  page: number;
  skips?: number;
  limit: number;
};

export class ProjectNotesHelper {
  public static create = async (body: ProjectNotesType) => {
    return ProjectNotes.create(body);
  };

  // Tab badge count for Notes. Mirrors findAll's filter — ACTIVE notes only.
  // Served by the new { projectId, status } index on ProjectNotesSchema.
  public static countByProject = (projectId: string) => {
    return ProjectNotes.countDocuments({
      projectId: ObjectId(projectId),
      status: CURRENT_STATUS.ACTIVE,
    });
  };

  public static findAll = async (query: projectNotesQuery) => {
    const { projectId, page, skips, limit } = query;

    if (!isValidObjectId(projectId)) return [];

    const matchQuery = {
      projectId: ObjectId(projectId),
      status: CURRENT_STATUS.ACTIVE,
    };

    const [total, items] = await Promise.all([
      ProjectNotes.countDocuments(matchQuery),
      ProjectNotes.aggregate([
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
          $project: {
            note: 1,
            userName: {
              $concat: [
                { $arrayElemAt: ["$userInfo.name.first", 0] },
                " ",
                { $arrayElemAt: ["$userInfo.name.last", 0] },
              ],
            },
            profileImage: {
              $arrayElemAt: ["$userInfo.profileImage", 0],
            },
            createdAt: 1,
            files: 1,
            comments: { $literal: 0 },
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

  public static delete = async (projectNoteId: string) => {
    return ProjectNotes.findByIdAndUpdate(projectNoteId, {
      $set: { status: CURRENT_STATUS.DELETED },
    });
  };

  public static put = async ({ projectNoteId, update }) => {
    return ProjectNotes.findByIdAndUpdate(projectNoteId, { $set: update });
  };
}
