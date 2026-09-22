// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { UsersHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../../utils/helpers/apiResponse";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import {
  ObjectId,
  getMonthAndYear,
  getTimeStamp,
  removeHours,
  timeAgo,
} from "../../../utils/helpers/commonHelper";
import { CompanyHelpers } from "../../company/helpers";
import { ProjectHelper } from "../../projects/helper";
import { PostsHelper } from "../../posts/helper";
import { USER_ROLE, USER_ROLES } from "../../../utils/enums/enums";
import { UserHelper } from "../../user/helper";
import { firebaseService } from "../../../services/firebaseAdmin";
import { Validator } from "node-input-validator";
import { Otp } from "../../../db";
import { UserRecord } from "firebase-admin/lib/auth/user-record";

export class UsersRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery = req.query;

      query.searchValue = query?.searchValue ? query?.searchValue : "";
      query.page = Number(query.page) || 1;
      query.limit = Number(query.limit) || 10;
      query.skips = (query.page - 1) * query.limit;

      const [users, count] = await UsersHelpers.findAll(query);

      const isActiveFunc = (date) => date > removeHours(new Date(), 24);

      const fullName = (name: { first?: string; last?: string }) => {
        return (name.first + " " + name.last)?.trim();
      };

      const op = await Promise.all(
        users.map(async (user) => {
          const obj = {
            ...user,
            fullName: fullName(user.name),
            createdAt: getTimeStamp(user.createdAt),
            isActive: false,
            lastActive: null,
            companyId: null,
            projects: [],
            posts: 0,
            invitedBy: "self",
          };

          if (obj.subscriptionActiveUntil) {
            obj.subscriptionActiveUntil = getTimeStamp(
              obj.subscriptionActiveUntil,
            );
          }
          const [company, lastActive] = await Promise.all([
            CompanyHelpers.getMyCompanies(user._id),
            UsersHelpers.getLastActive(user._id),
          ]);

          if (company.length) {
            obj.companyId = company[0].companyId;
          }

          if (company?.[0]?.companyId) {
            const [projects, posts, admin] = await Promise.all([
              ProjectHelper.findAll({ userId: user._id }),
              PostsHelper.getMyTotalPosts(user._id),
              CompanyHelpers.getCompanyAdminId(obj.companyId),
            ]);

            obj.posts = posts;
            if (projects.length) {
              obj.projects = projects.map((p) => p.name);
            }

            if (obj.roles != USER_ROLE.ADMIN) {
              const adminUser = await UsersHelpers.findOne(admin.userId);
              obj.invitedBy = fullName(adminUser?.name);
            }
          }

          if (lastActive.length) {
            obj.isActive = isActiveFunc(lastActive[0].updatedAt);
            if (obj.isActive) {
              obj.lastActive = timeAgo(lastActive[0].updatedAt, new Date());
            } else {
              obj.lastActive = getTimeStamp(lastActive[0].updatedAt);
            }
          }

          return obj;
        }),
      );

      const data = {
        users: op,
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

  public static getOne = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { id }: { id: string } = req.params;
      const data = await UsersHelpers.findOne(ObjectId(id));
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getActiveUserGraph = async (
    req: AuthenticatedRequest & { year: string },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      let year: number = Number(req.query?.year);

      if (!year || !Number(year)) {
        const date = getMonthAndYear(new Date());
        year = date.year;
      }

      const response = await UsersHelpers.getActiveUserGraph(Number(year));
      const data = {};

      for (let i = 1; i <= 12; i++) {
        data[i] = 0;
      }

      response.map((r) => {
        data[r._id] = r.total;
      });

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static createAccount = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        email: "required",
        phone: "required",
        "name.first": "required",
        "name.last": "required",
        otp: "required",
        sentViamail: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { phone, otp, sentViamail, name } = req.body;
      let { email, companyName } = req.body;

      let otpQuery: any = { phone, otp };
      email = email.toLowerCase().trim();

      if (sentViamail) {
        otpQuery = { email, otp };
      }

      const otpExists = await Otp.findOne(otpQuery);

      if (!otpExists) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid Otp",
          errors: "Invalid Otp",
        });
      }

      let firebaseAuthUser: UserRecord;

      try {
        const record = await firebaseService.findUser(email);

        if (!record) {
          firebaseAuthUser = await firebaseService.createUser(name, email);
        } else {
          firebaseAuthUser = record;
        }
      } catch (err) {
        if (err.code == "auth/user-not-found") {
          firebaseAuthUser = await firebaseService.createUser(name, email);
        } else {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: err.message,
          });
        }
      }

      const { uid } = firebaseAuthUser;

      const userObject: any = {
        name,
        phone,
        email,
        firebaseUid: uid,
        roles: USER_ROLE.ADMIN,
        userRole: USER_ROLES.at(-1),
      };

      if (companyName) {
        userObject.companyName = companyName;
      }

      const user = await UsersHelpers.create(userObject);

      if (!companyName) companyName = name.first;
      await CompanyHelpers.createCompanyWithAdminUser(companyName, user._id);

      return SuccessResponse(res, status.OK, {
        message: `Account Created successfully`,
      });
    } catch (error) {
      next(error);
    }
  };

  public static checkAccount = async (
    req: AuthenticatedRequest & { query: { email: string; phone: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        email: "required",
        phone: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      let { email, phone } = req.query;

      email = email.toLowerCase().trim();
      phone = phone.trim();

      const [isValidEmail, isValidPhone] = await Promise.all([
        UserHelper.findOne({ email }),
        UserHelper.findOne({ phone }),
      ]);

      return SuccessResponse(res, status.OK, {
        message: `Account checked successfully`,
        data: {
          isValidEmail: isValidEmail ? false : true,
          isValidPhone: isValidPhone ? false : true,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteAccount = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const user: any = await UserHelper.findOne({
        _id: ObjectId(req.body.userId),
      });
      let deleteUsers = [user];
      if (!user) {
        return SuccessResponse(res, status.OK, {
          message: `Account deleted successfully`,
        });
      }
      const companys = await CompanyHelpers.getMyCompanies(user._id);
      if (companys && companys.length) {
        user.companies = companys;
        user.companyId = companys[0].companyId;
      }

      if (
        user?.companies?.[0]?.role &&
        user.companies[0].role == USER_ROLE.ADMIN
      ) {
        const [users, projectIds] = await Promise.all([
          CompanyHelpers.getCompanyMembers([user.companyId]),
          ProjectHelper.getCompanyProjects(user.companyId),
        ]);

        const userFireBaseIds = await UserHelper.getUsersFireBaseId(
          users.map((u) => u.userId),
        );
        deleteUsers = userFireBaseIds;
        const userIds = users.map((u) => u.userId);

        const [posts, projectNotes] = await Promise.all([
          UserHelper.getPostIds(projectIds),
          UserHelper.getProjectNoteIds(projectIds),
        ]);

        const postIds = posts.map((p) => p._id);
        const projectNotesIds = projectNotes.map((p) => p._id);

        const getComments = await UserHelper.getCommentIds(
          projectIds,
          postIds,
          projectNotesIds,
        );

        let commentIds = [];

        getComments.map((a) => {
          const temp = a.map((a) => a._id);
          commentIds = [...commentIds, ...temp];
        });

        const getReplys = await UserHelper.getReplys(commentIds);
        const replyIds = getReplys.map((a) => a._id);
        commentIds = [...commentIds, ...replyIds];

        await Promise.all([
          UserHelper.deleteCompany(user.companyId),
          UserHelper.removeCompanyMembers(user.companyId),
          UserHelper.removeProjects(user.companyId),
          UserHelper.removeCompanyTags(user.companyId),
          UserHelper.deleteInvites(user.companyId),
          UserHelper.removeProjectMembers(projectIds),
          UserHelper.removeProjectPins(projectIds),
          UserHelper.deleteProjectTasks(projectIds),
          UserHelper.deleteProjectNotes(projectIds),
          UserHelper.deletePosts(postIds),
          UserHelper.deleteReports(postIds),
          UserHelper.removeComments(
            projectIds,
            postIds,
            projectNotesIds,
            replyIds,
          ),
          UserHelper.deleteLikes(commentIds, projectNotesIds),
          UserHelper.deleteNotifications(userIds),
        ]);
      }

      await Promise.all(
        deleteUsers.map(async (user) => {
          await Promise.all([
            UserHelper.clearUserDataExceptNameAndImage(user._id),
            UserHelper.deleteUserCompanyProfile(user._id),
            UserHelper.deleteUserProjectProfile(user._id),
            firebaseService.deleteUser(user.firebaseUid),
            UserHelper.deleteNotifications([user._id]),
            UserHelper.deleteFcmToken(user._id),
          ]);
        }),
      );

      if (
        user?.companies?.[0]?.role &&
        user.companies[0].role == USER_ROLE.ADMIN
      ) {
        await UserHelper.deleteMultipleUserprofiles(
          deleteUsers.map((user) => user._id),
        );
      }
      return SuccessResponse(res, status.OK, {
        message: `Account deleted successfully`,
      });
    } catch (error) {
      next(error);
    }
  };
}
