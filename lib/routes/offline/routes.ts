import * as express from "express";
import * as status from "http-status";
import { Validator } from "node-input-validator";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { isValidObjectId } from "../../utils/helpers/commonHelper";
import { ProjectHelper } from "../projects/helper";
import { OfflineHelper } from "./helper";
import {
  IOfflineBundleUser,
  IOfflineProjectBundle,
} from "../../utils/interfaces/offline";

export class OfflineRoutes {
  /**
   * One request replacing the four-per-project fan-out the app used to run for
   * its offline cache. Without projectIds the server picks the caller's top
   * projects; with them it refreshes just those (used after a local edit).
   */
  public static getBundle = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectIds: "string",
        timeZone: "string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { projectIds, timeZone } = req.query;
      const user: IOfflineBundleUser = {
        _id: req.user._id,
        companyId: req.user?.companies?.[0]?.companyId,
        role: req.user?.companies?.[0]?.role,
      };

      let targetIds: string[];

      if (projectIds) {
        const requested = String(projectIds)
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);

        if (requested.some((id) => !isValidObjectId(id))) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Invalid projectId",
          });
        }
        if (requested.length > OfflineHelper.MAX_PROJECTS) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: `At most ${OfflineHelper.MAX_PROJECTS} projectIds allowed`,
          });
        }

        const myProjectIds = await ProjectHelper.getMyProjectsArray(user._id);
        targetIds = requested.filter((id) => myProjectIds.includes(id));
      } else {
        targetIds = await OfflineHelper.getTargetProjectIds(user._id);
      }

      const [bundles, tags] = await Promise.all([
        Promise.all(
          targetIds.map((projectId) =>
            OfflineHelper.getProjectBundle(projectId, user, timeZone),
          ),
        ),
        OfflineHelper.getTags(user.companyId),
      ]);

      const projects: Record<string, IOfflineProjectBundle> = {};
      targetIds.forEach((projectId, index) => {
        projects[projectId] = bundles[index];
      });

      const data = { projects, tags };

      return SuccessResponse(res, status.OK, {
        message: "Offline bundle fetched successfully",
        data: { ...data, version: OfflineHelper.buildVersion(data) },
      });
    } catch (error) {
      next(error);
    }
  };
}
