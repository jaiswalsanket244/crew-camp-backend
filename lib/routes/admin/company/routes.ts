import * as status from "http-status";
import * as express from "express";

import { CompanyHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../../utils/helpers/apiResponse";
import { Validator } from "node-input-validator";
import { CompanyType } from "../../../utils/interfaces/schemaInterface";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";

export class CompanyRoutes {
  public static getCompanies = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery = req.query;
      const data = await CompanyHelpers.getCompanies(query);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getCompanyUsers = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const companyId: string = req.params.id;
      const query: PaginatedSearchQuery = req.query;
      const data = await CompanyHelpers.getCompanyUsers(companyId, query);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static editCompany = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const id: string = req.params.id;
      const { update }: { update: CompanyType } = req.body;
      const data = await CompanyHelpers.updateCompany(id, update);
      return SuccessResponse(res, status.OK, {
        message: "Data updated successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static changeUserRole = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        roles: "required|string",
        userId: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }
      const companyId: string = req.params.id;
      const roles: string = req.body.roles;
      const userId: string = req.body._id;
      const data = await CompanyHelpers.changeUserRole(
        userId,
        companyId,
        roles,
      );
      return SuccessResponse(res, status.OK, {
        message: "Data updated successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getCompanyDetails = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const companyId: string = req.params.id;
      const data = await CompanyHelpers.getCompanyDetails(companyId);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
