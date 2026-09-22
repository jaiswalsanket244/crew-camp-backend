import * as status from "http-status";
import * as express from "express";
import { InviteUsersHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../../utils/helpers/apiResponse";
import { Validator } from "node-input-validator";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { UserType } from "../../../utils/interfaces/schemaInterface";

export class InviteUserRoutes {
  public static getAllInvitedUser = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery = req.query;
      const user: UserType = req.user;
      const data = await InviteUsersHelpers.findAllInvitedUser(query, user);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
  public static inviteUser = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        emails: "required|array",
        "emails.*.email": "required|string",
        "emails.*.role": "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }
      const { emails }: { emails: { email: string; role: string }[] } =
        req.body;
      const user: UserType = req.user;

      const data = await InviteUsersHelpers.inviteUsers(
        emails || [],
        user.companyId.toString(),
        user._id.toString(),
      );
      return SuccessResponse(res, status.OK, {
        message: "Invite sent successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
