import * as express from "express";
import * as status from "http-status";
import { Validator } from "node-input-validator";

import {
  SuccessResponse,
  ErrorResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { CrewsHelper } from "./helper";
import { isManagerAndAbove } from "../../utils/helpers/users";
import { ProjectHelper } from "../projects/helper";
import { ROLES } from "../../utils/enums/enums";

export class CrewsRoutes {
  public static getAllCrews = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;
      query.page = Number(query.page) || 1;
      query.pageSize = Number(query.pageSize) || 50;
      query.skips = (query.page - 1) * query.pageSize;

      const data = await CrewsHelper.getAllCrewsData(
        req.user.companyId,
        query,
        req.user.companies?.[0]?.role,
      );

      return SuccessResponse(res, status.OK, {
        message: "Crews fetched successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getCrewList = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query = req.query;
      query.page = Number(query.page) || 1;
      query.pageSize = Number(query.pageSize) || 50;
      query.skips = (query.page - 1) * query.pageSize;

      const data = await CrewsHelper.getCrewList(req.user.companyId, query);

      return SuccessResponse(res, status.OK, {
        message: "Crew list fetched successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getCrewDetails = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { crewId } = req.params;
      const query = req.query;
      query.page = Number(query.page) || 1;
      query.pageSize = Number(query.pageSize) || 50;
      query.skips = (query.page - 1) * query.pageSize;

      if (!crewId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Crew ID is required",
        });
      }

      const data = await CrewsHelper.getCrewDetails(
        crewId,
        req.user.companyId,
        query,
      );

      return SuccessResponse(res, status.OK, {
        message: "Crew details fetched successfully",
        data,
      });
    } catch (error) {
      if (error.message.includes("Crew not found")) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: error.message,
        });
      }
      next(error);
    }
  };

  public static createCrew = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        name: "required|string",
        userIds: "required|array",
        "userIds.*": "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      if (!isManagerAndAbove(req.user.companies?.[0].role)) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Only MANAGER or above can create crews",
        });
      }

      const crew = await CrewsHelper.createCrew(
        req.body,
        req.user._id,
        req.user.companyId,
      );

      return SuccessResponse(res, status.CREATED, {
        message: "Crew created successfully",
        data: crew,
      });
    } catch (error) {
      if (
        error.message.includes("Only MANAGER or above") ||
        error.message.includes("User not found in company") ||
        error.message.includes("Some user IDs are not valid")
      ) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: error.message,
        });
      }
      next(error);
    }
  };

  public static updateCrew = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(
        { ...req.params, ...req.body },
        {
          crewId: "required|string",
          name: "string",
        },
      );

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { name } = req.body;
      if (!name) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Crew name is required for update",
        });
      }

      if (!isManagerAndAbove(req.user.companies?.[0].role)) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Only MANAGER or above can update crews",
        });
      }

      const updatedCrew = await CrewsHelper.updateCrew(
        req.params.crewId,
        req.user.companyId,
        req.body,
      );

      return SuccessResponse(res, status.OK, {
        message: "Crew updated successfully",
        data: updatedCrew,
      });
    } catch (error) {
      if (error.message.includes("You do not have permission")) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: error.message,
        });
      }
      next(error);
    }
  };

  public static deleteCrew = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(
        { ...req.params, ...req.body },
        {
          crewId: "required|string",
        },
      );

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      if (!isManagerAndAbove(req.user.companies?.[0].role)) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Only MANAGER or above can update crews",
        });
      }

      const updatedCrew = await CrewsHelper.deleteCrew(
        req.params.crewId,
        req.user.companyId,
      );

      return SuccessResponse(res, status.OK, {
        message: "Crew deleted successfully",
        data: updatedCrew,
      });
    } catch (error) {
      if (error.message.includes("You do not have permission")) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: error.message,
        });
      }
      next(error);
    }
  };

  public static updateMembers = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(
        { ...req.params, ...req.body },
        {
          crewId: "required|string",
          userIds: "required|array",
          "userIds.*": "required|string",
        },
      );

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      if (!isManagerAndAbove(req.user.companies?.[0].role)) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Only MANAGER or above can update members",
        });
      }

      const result = await CrewsHelper.updateMembers(
        req.params.crewId,
        req.body.userIds,
        req.user.companyId,
      );

      return SuccessResponse(res, status.OK, {
        message: result.message,
        data: result,
      });
    } catch (error) {
      if (
        error.message.includes("Crew not found") ||
        error.message.includes("Some user IDs are not valid") ||
        error.message.includes("At least one user ID is required")
      ) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: error.message,
        });
      }
      if (error.message.includes("You do not have permission")) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: error.message,
        });
      }
      next(error);
    }
  };

  public static updateCrewProject = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(
        { ...req.params, ...req.body },
        {
          crewId: "required|string",
          projectIds: "array",
        },
      );

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const result = await CrewsHelper.updateCrewProject(
        req.params.crewId,
        req.body.projectIds,
        req.user.companyId,
        req.user.companies?.[0]?.role,
      );

      return SuccessResponse(res, status.OK, {
        message: result.message,
        data: result,
      });
    } catch (error) {
      if (
        error.message.includes("Crew not found") ||
        error.message.includes("Some project IDs are not valid") ||
        error.message.includes("Project IDs must be an array")
      ) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: error.message,
        });
      }
      if (error.message.includes("You do not have permission")) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: error.message,
        });
      }
      next(error);
    }
  };

  public static getCompanyMembers = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const members = await ProjectHelper.getpeople(
        req.user.companyId,
        ROLES.ADMIN,
      );
      return SuccessResponse(res, status.OK, {
        message: "Company members fetched successfully",
        data: members,
      });
    } catch (error) {
      next(error);
    }
  };
}
