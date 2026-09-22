import * as httpStatus from "http-status";
import { Company, CompanyMember, User } from "../db";
import { config } from "../utils/configuration/config";
import { ErrorResponse } from "../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../utils/interfaces/authenticated-request";
import { Response, NextFunction } from "express";
import { ROLES, USER_ROLE } from "../utils/enums/enums";
import { verifyToken } from "../utils/helpers/commonHelper";
import {
  AccountDeactivatedResponse,
  isAccountDeactivated,
} from "../utils/helpers/accountStatus";

export class Middleware {
  JWT_SECRET: string;

  constructor() {
    this.JWT_SECRET = config.JWT_SECRET || "i am a tea pot";
  }

  public authMiddleware = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authorizationHeader = req.headers.authorization;
      if (!authorizationHeader || !req.user) {
        return this.sendForbiddenAccessResponse(res);
      }
      next();
    } catch (err) {
      return this.sendForbiddenAccessResponse(res);
    }
  };

  public jwtDecoder = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      let authorizationHeader = req.headers.authorization;
      if (!authorizationHeader) {
        return next();
      }
      if (authorizationHeader.includes("Bearer")) {
        authorizationHeader = authorizationHeader.split(" ")[1];
      }
      const decoded = await verifyToken(authorizationHeader);

      const [user, companys]: any = await Promise.all([
        User.findById(decoded.data._id).lean(),
        CompanyMember.find(
          { userId: decoded.data._id, status: "ACTIVE" },
          { companyId: 1, role: 1 },
        ),
      ]);

      // Tokens are long-lived, so deactivation has to be enforced on every
      // request rather than only at login.
      if (!companys?.length && (await isAccountDeactivated(decoded.data._id))) {
        return AccountDeactivatedResponse(res);
      }

      if (companys && companys.length) {
        user.companies = companys;
        user.companyId = companys[0].companyId;
        user.roles = companys?.[0]?.role;
      }

      if (!user) {
        return this.sendForbiddenAccessResponse(res);
      }
      user.fullName = user.name.first + " " + user.name.last;

      if (user.companyId) {
        const company: any = await Company.findById(user.companyId, {
          companyLogo: 1,
          userId: 1,
        }).lean();
        if (company) {
          user.companyLogo = company.companyLogo || "";
        }
        user.adminId = company.userId;
      }

      req.user = user;
      req.token = decoded;
      next();
    } catch (error) {
      next(error);
    }
  };

  public superAdminMiddleware = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.user || req.user.roles !== ROLES.SUPER_ADMIN) {
      return this.sendForbiddenAccessResponse(res);
    }
    next();
  };

  public adminMiddleware = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.user || req.user.roles !== ROLES.ADMIN) {
      return this.sendForbiddenAccessResponse(res);
    }
    next();
  };

  // Allows company owners/admins and managers. Member role is resolved from
  // CompanyMember.role in jwtDecoder, so req.user.roles holds the company role.
  public adminOrManagerMiddleware = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const allowedRoles: string[] = [
      USER_ROLE.SUPERADMIN,
      USER_ROLE.ADMIN,
      USER_ROLE.MANAGER,
    ];
    if (!req.user || !allowedRoles.includes(req.user.roles)) {
      return this.sendForbiddenAccessResponse(res);
    }
    next();
  };

  public adminOrModeratorMiddleware = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.user || req.user.roles === ROLES.USER) {
      return this.sendForbiddenAccessResponse(res);
    }

    if (
      [ROLES.SUPER_ADMIN, ROLES.MODERATOR, ROLES.ADMIN].includes(req.user.roles)
    ) {
      next();
    } else {
      return this.sendForbiddenAccessResponse(res);
    }
  };

  private sendForbiddenAccessResponse(res: Response) {
    return ErrorResponse(res, httpStatus.UNAUTHORIZED, {
      message: "Forbidden Access",
    });
  }
}
