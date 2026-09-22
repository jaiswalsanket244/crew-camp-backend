import * as status from "http-status";
import * as express from "express";
import { InviteUsersHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { Validator } from "node-input-validator";
import { UserType } from "../../utils/interfaces/schemaInterface";
import { RevenueCatService } from "../../services/revenueCatService";
import { MEMBER_TYPE, SUBSCRIPTION_STATUS } from "../../utils/enums/enums";
import { CompanyHelpers } from "../company/helpers";
import { removeHours } from "../../utils/helpers/commonHelper";
import { config } from "../../utils/configuration/config";
import { UserHelper } from "../user/helper";
import { ShortLinkHelpers } from "../shortLink/helpers";
import { ProjectHelper } from "../projects/helper";

export class InviteUserRoutes {
  public static inviteUser = async (
    req: AuthenticatedRequest & { query: { role: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        role: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { role, projectId } = req.query;
      const user: UserType = req.user;

      const inviteCode = await InviteUsersHelpers.inviteUsers(
        role,
        user.companyId,
        user._id.toString(),
        projectId,
      );

      let link = `${config.WEB_URL}/invitations?inviteCode=${inviteCode}&userName=${user.fullName}`;
      if (role === MEMBER_TYPE.GUEST) {
        link += `&isGuest=true`;
      }

      const url = await ShortLinkHelpers.createLink({
        url: link,
      });

      return SuccessResponse(res, status.OK, {
        message: "Invite sent successfully.",
        data: {
          inviteCode,
          url,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static validateLink = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        inviteCode: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { inviteCode } = req.params;
      const createdAt = removeHours(new Date(), 240);
      const check = await InviteUsersHelpers.validateInvite(
        inviteCode,
        createdAt,
      );

      const admin = await CompanyHelpers.getCompanyAdminId(check.companyId);
      const [subscriptionStatus, adminUser] = await Promise.all([
        RevenueCatService.getSubScriptionStatus(admin?.userId),
        UserHelper.findOne({ _id: admin?.userId }),
      ]);

      const data = {
        companyName: adminUser?.companyName,
      };
      if (check.role === MEMBER_TYPE.GUEST) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Guest link is not valid for this action.",
        });
      }

      if (subscriptionStatus?.status == SUBSCRIPTION_STATUS.NO_SUBSCRIPTION) {
        const companyMembers = await CompanyHelpers.getCompanyMembers([
          check.companyId,
        ]);
        if (companyMembers.length >= 2) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Invite link not Approved.",
          });
        }
      }

      if (check) {
        return SuccessResponse(res, status.OK, {
          message: "Invite link Approved.",
          data,
        });
      }

      return ErrorResponse(res, status.BAD_REQUEST, {
        message: "Invite link not Approved.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static validateGuestLink = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        inviteCode: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { inviteCode } = req.params;
      const createdAt = removeHours(new Date(), 240);
      const check = await InviteUsersHelpers.validateInvite(
        inviteCode,
        createdAt,
      );

      const admin = await CompanyHelpers.getCompanyAdminId(check.companyId);
      const [subscriptionStatus, adminUser] = await Promise.all([
        RevenueCatService.getSubScriptionStatus(admin?.userId),
        UserHelper.findOne({ _id: admin?.userId }),
      ]);

      const data = {
        companyName: adminUser?.companyName,
      };

      if (subscriptionStatus?.status == SUBSCRIPTION_STATUS.NO_SUBSCRIPTION) {
        const companyMembers = await CompanyHelpers.getCompanyMembers([
          check.companyId,
        ]);
        if (companyMembers.length >= 2) {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Invite link not Approved.",
          });
        }
      }

      if (check) {
        if (check?.projectId) {
          const myProjectIds = await ProjectHelper.getMyProjectsArray(
            req.user._id,
          );
          if (myProjectIds.includes(check.projectId.toString())) {
            return ErrorResponse(res, status.BAD_REQUEST, {
              message: "You are already a member of this project.",
            });
          }
          const projectCompanyId = await ProjectHelper.getCompanyId(
            check?.projectId,
          );

          if (
            projectCompanyId?.companyId?.toString() ===
            req.user.companyId.toString()
          ) {
            return ErrorResponse(res, status.BAD_REQUEST, {
              message:
                "You are not able to join the guest project which are associated with your company",
            });
          }

          await ProjectHelper.joinProject(
            req.user._id,
            check.projectId,
            MEMBER_TYPE.GUEST,
          );
          return SuccessResponse(res, status.OK, {
            message: "Invite link Approved and Project is joined",
            data,
          });
        } else {
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Invite link is not valid for this action.",
          });
        }
      }

      return ErrorResponse(res, status.BAD_REQUEST, {
        message: "Invite link not Approved.",
      });
    } catch (error) {
      next(error);
    }
  };
}
