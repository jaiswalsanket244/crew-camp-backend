// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { ProductsHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { ProductType } from "../../utils/interfaces/schemaInterface";
import { Validator } from "node-input-validator";

export class ProductsRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const data = await ProductsHelpers.findAll(req.query, req.user._id);
      return SuccessResponse(res, status.OK, {
        message: "Success.",
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
      const id = req.params.id;

      const data = await ProductsHelpers.findOne(id);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };

  public static update = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const id = req.params.id;
      const userId = req.user._id;
      const update: ProductType = req.body;
      const data = await ProductsHelpers.findAndUpdate(id, userId, update);
      if (!data) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Bad request. check the body",
        });
      }
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };

  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const document: ProductType = req.body;

      const validator = new Validator(req.body, {
        title: "required",
        description: "required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      document.createdBy = req.user._id;
      const data = await ProductsHelpers.create(document);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };

  public static delete = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const id = req.params.id;
      const userId = req.user._id;
      const data = ProductsHelpers.softDelete(id, userId);
      if (!data) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Bad request. check the body",
        });
      }
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };
}
