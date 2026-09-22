import * as express from "express";
import * as httpStatus from "http-status";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { ApiKeysHelper } from "./helpers";

export class ApiKeysRoutes {
  public static createApiKey = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { name, expiresAt = new Date(2100, 0, 1) } = req.body;
      const { companyId, _id: userId } = req.user;

      if (!name || name.trim().length === 0) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "API key name is required",
        });
      }

      const expiry = expiresAt ? new Date(expiresAt) : undefined;
      if (expiry && expiry <= new Date()) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Expiry date must be in the future",
        });
      }

      const apiKey = await ApiKeysHelper.createApiKey(
        companyId,
        userId,
        name.trim(),
        expiry,
      );

      return SuccessResponse(res, httpStatus.CREATED, {
        message: "API key created successfully",
        data: {
          apiKey: {
            keyId: apiKey.keyId,
            keySecret: apiKey.keySecret,
            name: apiKey.name,
            expiresAt: apiKey.expiresAt,
          },
          note: "Store the key secret securely. It will not be shown again.",
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static getUserApiKeys = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const companyId = req.user.companyId;
      const apiKeys = await ApiKeysHelper.getUserApiKeys(companyId);

      return SuccessResponse(res, httpStatus.OK, { data: apiKeys });
    } catch (error) {
      next(error);
    }
  };

  public static toggleApiKey = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const keyId = req.params?.id;
      const companyId = req.user.companyId;

      if (!keyId) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Key ID is required",
        });
      }

      await ApiKeysHelper.updateApiKey(keyId, companyId);

      return SuccessResponse(res, httpStatus.OK, {
        message: "API key updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteApiKey = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const keyId = req.params?.id;
      const companyId = req.user.companyId;

      if (!keyId) {
        return ErrorResponse(res, httpStatus.BAD_REQUEST, {
          message: "Key ID is required",
        });
      }

      await ApiKeysHelper.deleteApiKey(keyId, companyId);

      return SuccessResponse(res, httpStatus.OK, {
        message: "API key is deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
