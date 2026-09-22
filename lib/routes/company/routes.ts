import * as status from "http-status";
import * as express from "express";

import { CompanyHelpers } from "./helpers";
import { Validator } from "node-input-validator";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { Company } from "../../db";
import {
  convertTime,
  isValidObjectId,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import { ProjectHelper } from "../projects/helper";
import { UserHelper } from "../user/helper";
import { firebaseService } from "../../services/firebaseAdmin";
import {
  CURRENT_COMPANY_MEMBER_STATUS,
  USER_ROLE,
} from "../../utils/enums/enums";
import { allowChangeMemberState } from "../../utils/helpers/users";
import { SubscriptionService } from "../../services/subscriptionService";
import {
  IMemberStateChangePayload,
  IMemberStateGuardResult,
} from "../../utils/interfaces/companyMember";

export class CompanyRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const user = req.user;
      if (!user.companyName) user.companyName = user.name.first;

      await CompanyHelpers.createCompanyWithAdminUser(
        user.companyName,
        user._id,
      );

      return SuccessResponse(res, status.OK, {
        message: "company created successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static join = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        inviteCode: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { inviteCode } = req.body;

      // A deactivated member must be re-enabled by an admin/manager — redeeming
      // a fresh invite link is not a way back in.
      const existingMembership = await CompanyHelpers.getMembershipByInviteCode(
        inviteCode,
        req.user._id,
      );

      if (
        existingMembership?.status === CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED
      ) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message:
            "Your access to this company was deactivated. Ask an admin or manager to re-enable your account.",
        });
      }

      await CompanyHelpers.addToCompany(inviteCode, req.user._id);

      return SuccessResponse(res, status.OK, {
        message: "company created successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getCompanyUsersLight = async (
    req: AuthenticatedRequest & {
      query: PaginatedSearchQuery & {
        searchValue?: string;
        selectedFilters: string;
        projectId?: string;
        includeDeactivated?: string;
      };
    },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;
      query.page = Number(query.page) || 1;
      query.pageSize = Number(query.pageSize) || 50;
      query.skips = (query.page - 1) * query.pageSize;
      if (query?.selectedFilters) {
        query.selectedFilters = JSON.parse(query.selectedFilters);
      }

      if (!req.user) {
        const { projectId } = query;
        const emptyResponse = {
          message: "Data retrieved successfully.",
          data: [
            {
              items: [],
              total: 0,
              page: 1,
              pageSize: query.pageSize,
              totalPages: 0,
            },
          ],
        };
        if (!projectId || !isValidObjectId(projectId)) {
          return SuccessResponse(res, status.OK, emptyResponse);
        }
        const project = await ProjectHelper.getCompanyId(projectId);
        if (!project?.companyId) {
          return SuccessResponse(res, status.OK, emptyResponse);
        }
        const data = await CompanyHelpers.getCompanyUsersLight(
          [project.companyId],
          query,
          true,
        );
        return SuccessResponse(res, status.OK, {
          message: "Data retrieved successfully.",
          data,
        });
      }

      const companyIds = req?.user?.companies?.map((a) => a.companyId) || [];
      const data = await CompanyHelpers.getCompanyUsersLight(
        companyIds,
        query,
        false,
        query.includeDeactivated === "true",
      );

      if (data?.[0]?.items) {
        data[0].items = data[0].items.map((m) => ({
          ...m,
          createdAt: convertTime(m.createdAt, true),
        }));
      }

      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getCompanyUsers = async (
    req: AuthenticatedRequest & {
      query: PaginatedSearchQuery & {
        searchValue?: string;
        selectedFilters: string;
      };
    },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;
      query.page = Number(query.page) || 1;
      query.pageSize = Number(query.pageSize) || 50;
      query.skips = (query.page - 1) * query.pageSize;
      if (query?.selectedFilters) {
        query.selectedFilters = JSON.parse(query.selectedFilters);
      }

      const companyIds = req?.user?.companies?.map((a) => a.companyId) || [];

      const projects: any = await ProjectHelper.getCompanyData(companyIds);
      const projectIds = projects.map((p, i) => {
        projects[i].createdAt = convertTime(p.createdAt);
        return p._id;
      });

      const data = await CompanyHelpers.getCompanyUsers(
        companyIds,
        query,
        projectIds,
      );

      if (data?.[0]?.items) {
        data[0].items = data[0].items.map((m) => {
          const existingProjects = m?.projects?.map((p) => p.toString());
          const nonExistingProjects = projects.filter(
            (p) => !existingProjects.includes(p._id.toString()),
          );

          return {
            ...m,
            createdAt: convertTime(m.createdAt, true),
            projects: nonExistingProjects,
          };
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

  public static removeAccount = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: { userId: string } = req.query;

      if (!query.userId || !isValidObjectId(query.userId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "your are not authorized",
        });
      }
      const user: any = await UserHelper.findOne({
        _id: ObjectId(query.userId),
      });

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
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "your are not authorized to leave",
        });
      }

      await Promise.all([
        UserHelper.clearUserDataExceptNameAndImage(user._id),
        UserHelper.deleteUserCompanyProfile(user._id),
        UserHelper.deleteUserProjectProfile(user._id),
        firebaseService.deleteUser(user.firebaseUid),
        UserHelper.deleteNotifications([user._id]),
        UserHelper.deleteFcmToken(user._id),
        UserHelper.removeUserFromCrews(user._id),
      ]);

      return SuccessResponse(res, status.OK, {
        message: "removed successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static changeAccessType = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        userId: "required",
        role: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      await CompanyHelpers.changeAccessType(req.body);

      return SuccessResponse(res, status.OK, {
        message: "removed successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Shared guard for deactivate / re-enable. Resolves the target membership
   * inside the actor's company and rejects self-targeting, the company owner,
   * and any member the actor does not outrank.
   */
  private static resolveManageableMember = async (
    req: AuthenticatedRequest,
  ): Promise<IMemberStateGuardResult> => {
    const { userId } = req.body as IMemberStateChangePayload;
    const companyId = req.user?.companyId;

    if (!companyId) {
      return {
        error: {
          statusCode: status.BAD_REQUEST,
          message: "No company found for this user.",
        },
      };
    }

    if (userId === req.user._id.toString()) {
      return {
        error: {
          statusCode: status.BAD_REQUEST,
          message: "You cannot change the status of your own account.",
        },
      };
    }

    const [membership, company] = await Promise.all([
      CompanyHelpers.getMembership(companyId, userId),
      CompanyHelpers.getCompanyAdminId(companyId),
    ]);

    if (!membership) {
      return {
        error: {
          statusCode: status.NOT_FOUND,
          message: "Member not found in your company.",
        },
      };
    }

    if (company?.userId?.toString() === userId) {
      return {
        error: {
          statusCode: status.BAD_REQUEST,
          message: "The company owner cannot be deactivated.",
        },
      };
    }

    if (!allowChangeMemberState(req.user.roles, membership.role)) {
      return {
        error: {
          statusCode: status.FORBIDDEN,
          message: "You are not authorized to change this member's status.",
        },
      };
    }

    return { companyId, membership };
  };

  public static deactivateMember = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        userId: "required|string",
      });

      const matched = await validator.check();

      if (!matched || !isValidObjectId(req.body.userId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const guard = await CompanyRoutes.resolveManageableMember(req);

      if (guard.error) {
        return ErrorResponse(res, guard.error.statusCode, {
          message: guard.error.message,
        });
      }

      if (guard.membership.status !== CURRENT_COMPANY_MEMBER_STATUS.ACTIVE) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "This member is not active.",
        });
      }

      const { userId } = req.body as IMemberStateChangePayload;

      await CompanyHelpers.deactivateMember(
        guard.companyId,
        userId,
        req.user._id,
      );

      // Drop push tokens so a locked-out member stops receiving notifications;
      // they re-register on their next successful login.
      await UserHelper.deleteFcmToken(ObjectId(userId));

      return SuccessResponse(res, status.OK, {
        message: "Member deactivated successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static reactivateMember = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        userId: "required|string",
      });

      const matched = await validator.check();

      if (!matched || !isValidObjectId(req.body.userId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const guard = await CompanyRoutes.resolveManageableMember(req);

      if (guard.error) {
        return ErrorResponse(res, guard.error.statusCode, {
          message: guard.error.message,
        });
      }

      if (
        guard.membership.status !== CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED
      ) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "This member is not deactivated.",
        });
      }

      // Re-enabling consumes a seat again, so it must respect the plan limit.
      const seats = await SubscriptionService.getSeatAvailability(
        guard.companyId,
      );

      if (!seats.hasSeatAvailable) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: `Your plan allows ${seats.maxAllowedUsers} active members. Upgrade your plan or deactivate another member first.`,
        });
      }

      const { userId } = req.body as IMemberStateChangePayload;

      await CompanyHelpers.reactivateMember(guard.companyId, userId);

      return SuccessResponse(res, status.OK, {
        message: "Member re-enabled successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateLogo = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { companyLogo } = req.body;
      const companyId = req.user.companyId;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No company found for this user.",
        });
      }

      await Company.findByIdAndUpdate(
        companyId,
        { companyLogo: companyLogo || "" },
        { new: true },
      );

      return SuccessResponse(res, status.OK, {
        message: "Company logo updated successfully.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getShowDefaultTags = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const companyId = req.user.companyId;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No company found for this user.",
        });
      }

      const company = await Company.findById(companyId, {
        showDefaultTags: 1,
      }).lean();

      return SuccessResponse(res, status.OK, {
        data: { showDefaultTags: company?.showDefaultTags !== false },
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateShowDefaultTags = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        showDefaultTags: "required|boolean",
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { showDefaultTags } = req.body;
      const companyId = req.user.companyId;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No company found for this user.",
        });
      }

      await Company.findByIdAndUpdate(
        companyId,
        { showDefaultTags },
        { new: true },
      );

      return SuccessResponse(res, status.OK, {
        message: showDefaultTags
          ? "Default tags enabled successfully."
          : "Default tags disabled successfully.",
      });
    } catch (error) {
      next(error);
    }
  };
}
