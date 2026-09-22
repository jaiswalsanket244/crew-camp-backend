import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import {
  Posts,
  Project,
  ProjectMember,
  ProjectNotes,
  ProjectTasks,
} from "../../../db";
import {
  ObjectId,
  getUserNamePipeline,
} from "../../../utils/helpers/commonHelper";
import { CURRENT_STATUS } from "../../../utils/enums/enums";
import { Types } from "mongoose";
type mongoId = string;
export class ProjectsHelpers {
  public static getProjects = async (
    query: PaginatedSearchQuery & {
      companyId: Types.ObjectId;
      searchvalue?: string;
    },
  ) => {
    let searchQuery: any = {
      $match: {},
    };
    if (query.searchValue) {
      searchQuery = {
        $search: {
          index: "projectSearch",
          text: {
            query: query.searchValue,
            path: ["name", "description"],
          },
        },
      };
    }
    return Promise.all([
      Project.aggregate([
        searchQuery,
        {
          $skip: query.skips,
        },
        {
          $limit: query.limit,
        },
      ]),
      Project.aggregate([
        searchQuery,
        {
          $count: "total",
        },
      ]),
    ]);
  };

  public static getProjectsMembersCount = async (projectId: Types.ObjectId) => {
    return ProjectMember.countDocuments({
      projectId: projectId,
      status: CURRENT_STATUS.ACTIVE,
    });
  };

  public static getProjectPostsCount = async (projectId: Types.ObjectId) => {
    return Posts.aggregate([
      {
        $match: {
          projectId: projectId,
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      {
        $sort: {
          createdAt: 1,
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: 1,
          },
          lastUpdate: {
            $last: "$createdAt",
          },
        },
      },
    ]);
  };

  public static getProjectsTasksCount = async (projectId: mongoId) => {
    return ProjectTasks.aggregate([
      {
        $match: {
          projectId: ObjectId(projectId),
        },
      },
      {
        $sort: {
          createdAt: 1,
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: 1,
          },
          lastUpdate: {
            $last: "$createdAt",
          },
        },
      },
    ]);
  };

  public static getProjectsNotesCount = async (projectId: mongoId) => {
    return ProjectNotes.aggregate([
      {
        $match: {
          projectId: ObjectId(projectId),
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      {
        $sort: {
          createdAt: 1,
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: 1,
          },
          lastUpdate: {
            $last: "$createdAt",
          },
        },
      },
    ]);
  };

  public static getProjectMembersList = async (projectId: mongoId) => {
    const userNamePipeline = getUserNamePipeline();
    return ProjectMember.aggregate([
      {
        $match: {
          projectId: ObjectId(projectId),
          status: CURRENT_STATUS.ACTIVE,
        },
      },
      ...userNamePipeline,
      {
        $lookup: {
          from: "activitylogs",
          let: { userId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$userId", "$$userId"],
                },
              },
            },
            {
              $sort: {
                createdAt: -1,
              },
            },
            {
              $limit: 1,
            },
          ],
          as: "activity",
        },
      },
      {
        $addFields: {
          activity: {
            $arrayElemAt: ["$activity.updatedAt", 0],
          },
        },
      },
      {
        $project: {
          userInfo: 0,
        },
      },
    ]);
  };
}
