// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { ProductsHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../../utils/interfaces/authenticated-request";
import { SuccessResponse } from "../../../utils/helpers/apiResponse";
import {
  ProductType,
  UserType,
} from "../../../utils/interfaces/schemaInterface";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
export class ProductsRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const query: PaginatedSearchQuery = req.query;
      const user: UserType = req.user;
      const data = await ProductsHelpers.findAll(query, user);
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
      const id: string = req.params.id;
      const data = await ProductsHelpers.findOne(id);
      return SuccessResponse(res, status.OK, {
        message: "Data retrieved successfully.",
        data,
      });
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
      const id: string = req.params.id;
      const { update }: { update: ProductType } = req.body;
      const data = await ProductsHelpers.findAndUpdate({ id, update });
      return SuccessResponse(res, status.OK, {
        message: "Data updated successfully.",
        data,
      });
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
      const document: any = req.body;
      const user: UserType = req.user;
      document.createdBy = user._id;
      document.sellerStripeAccountId = user.stripeAccountId;
      const data = await ProductsHelpers.create(document);
      return SuccessResponse(res, status.OK, {
        message: "Data created successfully.",
        data,
      });
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
      const id: string = req.params.id;
      const data = ProductsHelpers.softDelete(id);
      return SuccessResponse(res, status.OK, {
        message: "Data deleted successfully.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
