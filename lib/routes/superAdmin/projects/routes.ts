// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { ProjectsHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import { SuccessResponse } from "../../../utils/helpers/apiResponse";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import {
  getTimeStamp,
  removeHours,
  timeAgo,
} from "../../../utils/helpers/commonHelper";
import { Types, isValidObjectId } from "mongoose";
import { UserHelper } from "../../user/helper";
import { CompanyHelpers } from "../../company/helpers";

export class ProjectsRoutes {
  public static get = async (
    req: AuthenticatedRequest & {
      query: PaginatedSearchQuery & { companyId: Types.ObjectId };
    },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;

      query.searchValue = query?.searchValue ? query?.searchValue : "";
      query.page = Number(query.page) || 1;
      query.limit = Number(query.limit) || 10;
      query.skips = (query.page - 1) * query.limit;

      let data = {
        projects: [],
        page: query.page,
        totalPages: query.page,
        count: 0,
      };

      const [projects, countDocuments] =
        await ProjectsHelpers.getProjects(query);

      const op = await Promise.all(
        projects.map(async (p) => {
          const obj = {
            ...p,
            createdAt: getTimeStamp(p.createdAt),
            fullName: null,
            companyName: null,
            projectMembers: 0,
            posts: 0,
            lastPost: null,
            tasks: 0,
            lastTask: null,
            notes: 0,
            lastNote: null,
            lastUpdatedAt: null,
          };

          const [createdBy, company, projectMembers, posts, tasks, notes] =
            await Promise.all([
              UserHelper.findOne({ _id: p.userId }),
              CompanyHelpers.getCompanyAdminId(p.companyId),
              ProjectsHelpers.getProjectsMembersCount(p._id),
              ProjectsHelpers.getProjectPostsCount(p._id),
              ProjectsHelpers.getProjectsTasksCount(p._id),
              ProjectsHelpers.getProjectsNotesCount(p._id),
            ]);

          if (createdBy?.name?.first) {
            obj.fullName = createdBy?.name?.first + " " + createdBy?.name?.last;
          }

          if (company?.name) {
            obj.companyName = company?.name;
          }

          obj.projectMembers = projectMembers;

          if (posts?.length) {
            obj.posts = posts[0].total;
            obj.lastPost = posts[0].lastUpdate;
            obj.lastUpdatedAt = posts[0].lastUpdate;
          }

          if (tasks?.length) {
            obj.tasks = tasks[0].total;
            obj.lastTask = tasks[0].lastUpdate;
            if (obj?.lastUpdatedAt) {
              if (obj?.lastUpdatedAt < tasks[0].lastUpdate) {
                obj.lastUpdatedAt = tasks[0].lastUpdate;
              }
            } else {
              obj.lastUpdatedAt = tasks[0].lastUpdate;
            }
          }

          if (notes?.length) {
            obj.notes = notes[0].total;
            obj.lastNote = notes[0].lastUpdate;
            if (obj?.lastUpdatedAt) {
              if (obj?.lastUpdatedAt < notes[0].lastUpdate) {
                obj.lastUpdatedAt = notes[0].lastUpdate;
              }
            } else {
              obj.lastUpdatedAt = notes[0].lastUpdate;
            }
          }

          if (obj.lastUpdatedAt) {
            obj.lastUpdatedAt = getTimeStamp(obj.lastUpdatedAt);
          }

          return obj;
        }),
      );

      const count = countDocuments?.[0]?.total;
      data = {
        projects: op,
        page: query.page,
        totalPages: Math.ceil(count / query.limit),
        count,
      };

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static members = async (
    req: AuthenticatedRequest & {
      query: PaginatedSearchQuery & { projectId: string };
    },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;
      const { projectId } = query;

      query.searchValue = query?.searchValue ? query?.searchValue : "";
      query.page = Number(query.page) || 1;
      query.limit = Number(query.limit) || 10;
      query.skips = (query.page - 1) * query.limit;

      let data = [];

      if (isValidObjectId(projectId)) {
        const isActiveFunc = (date) => date > removeHours(new Date(), 24);
        const response = await ProjectsHelpers.getProjectMembersList(projectId);
        data = response.map((user) => {
          const obj = {
            ...user,
          };
          if (user?.activity) {
            obj.isActive = isActiveFunc(user.activity);
            if (obj.isActive) {
              obj.lastActive = timeAgo(user.activity, new Date());
            } else {
              obj.lastActive = getTimeStamp(user.activity);
            }
          }

          return obj;
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
