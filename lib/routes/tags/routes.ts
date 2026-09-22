import * as express from "express";
import * as status from "http-status";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { TagsHelper } from "./helper";
import { Validator } from "node-input-validator";
import { TAGS_FOR } from "../../utils/enums/enums";
import { Company } from "../../db";

export class TagsRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        tag: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      req.body.tagFor = req.body?.tagFor ? req.body.tagFor : TAGS_FOR.PROJECT;

      const createdTag = await TagsHelper.create(req.user.companyId, req.body);

      return SuccessResponse(res, status.OK, {
        message: "Tag created successfully",
        data: {
          createdTagId: createdTag._id,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static getTags = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      let tagFor: TAGS_FOR = TAGS_FOR.PROJECT;

      if (
        req.query?.tagFor === TAGS_FOR.POST ||
        req.query?.tagFor === TAGS_FOR.PROJECT
      ) {
        tagFor = req.query.tagFor;
      }

      const companyId = req?.user?.companyId;

      const [company, custom] = await Promise.all([
        companyId
          ? Company.findById(companyId, { showDefaultTags: 1 }).lean()
          : Promise.resolve(null),
        TagsHelper.getCustom(companyId, tagFor),
      ]);

      const showDefaultTags = company?.showDefaultTags !== false;
      const regular = showDefaultTags
        ? await TagsHelper.getDefault(tagFor)
        : [];

      return SuccessResponse(res, status.OK, {
        data: [...regular, ...custom],
      });
    } catch (error) {
      next(error);
    }
  };

  public static editTags = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        tag: "string",
        color: "string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      await TagsHelper.update(req.params.id, req.body);
      return SuccessResponse(res, status.OK, {
        message: "Tag updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static deleteTag = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      await TagsHelper.delete(req.params.id);
      return SuccessResponse(res, status.OK, {
        message: "Tag deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getProjectsTags = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        id: "required|string",
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const data = await TagsHelper.getProjectsTags(req.params.id);
      return SuccessResponse(res, status.OK, {
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}
