import * as httpStatus from "http-status";
import { Response, NextFunction } from "express";
import { ApiKeyService } from "../services/apiKeyService";
import { ErrorResponse } from "../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../utils/interfaces/authenticated-request";
import { CompanyMember, User } from "../db";
import { CURRENT_STATUS, SUBSCRIPTION_STATUS } from "../utils/enums/enums";
import { RevenueCatService } from "../services/revenueCatService";
import { stripeService } from "../services/stripeService";
import { cacheService } from "../services/redis/cacheService";
import { Types } from "mongoose";

const SUBSCRIPTION_CACHE_PREFIX = "apikey:subscription:";
// 5 minutes for an active subscription, 1 minute for a denial.
const SUBSCRIPTION_CACHE_TTL_SECONDS = 300;
const SUBSCRIPTION_DENIED_CACHE_TTL_SECONDS = 60;

export interface ApiKeyAuthenticatedRequest extends AuthenticatedRequest {
  apiKey?: any;
}

export class ApiKeyMiddleware {
  public auth = async (
    req: ApiKeyAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      let authorizationHeader = req.headers.authorization;
      if (!authorizationHeader) {
        return this.sendForbiddenAccessResponse(res);
      }

      if (authorizationHeader.includes("Bearer")) {
        authorizationHeader = authorizationHeader.split(" ")[1];
      }

      const apiKey =
        await ApiKeyService.validateApiKeyWithId(authorizationHeader);

      if (!apiKey) {
        return this.sendForbiddenAccessResponse(res);
      }

      req.apiKey = apiKey;
      req.isExternalRequest = true;

      const [user, companys]: any = await Promise.all([
        User.findById(apiKey.userId).lean(),
        CompanyMember.find(
          { companyId: apiKey.companyId, status: CURRENT_STATUS.ACTIVE },
          { companyId: 1, role: 1 },
        ),
      ]);

      if (!user) {
        return this.sendForbiddenAccessResponse(res);
      }

      const subscribed = await this.hasActiveSubscription(
        apiKey.userId,
        user.stripeCustomerId,
      );

      if (!subscribed) {
        return this.sendForbiddenAccessResponse(res);
      }

      if (companys && companys.length) {
        user.companies = companys;
        user.companyId = companys[0].companyId;
      }

      user.fullName = user.name.first + " " + user.name.last;
      req.user = user;

      next();
    } catch (error) {
      return ErrorResponse(res, httpStatus.INTERNAL_SERVER_ERROR, {
        message: "API key validation failed",
      });
    }
  };

  /**
   * Subscription gate for the external API, cached so a third-party integrator's
   * traffic doesn't put a RevenueCat (and sometimes Stripe) round trip in front
   * of every single request — which made /v1's latency and uptime a function of
   * theirs, and burned their rate limit.
   *
   * A lapsed subscription keeps working for at most the positive TTL. Negative
   * results are cached far more briefly so a customer who has just fixed their
   * billing isn't locked out for the full window. A Redis outage simply means
   * every call is a live check, as before.
   */
  private hasActiveSubscription = async (
    userId: Types.ObjectId,
    stripeCustomerId?: string,
  ): Promise<boolean> => {
    const cacheKey = `${SUBSCRIPTION_CACHE_PREFIX}${userId.toString()}`;

    const cached = await cacheService.get<boolean>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const revenueCat = await RevenueCatService.getSubScriptionStatus(userId);
    let active = revenueCat === SUBSCRIPTION_STATUS.ACTIVE;

    if (!active) {
      active = Boolean(await stripeService.isStatusActive(stripeCustomerId));
    }

    await cacheService.set(cacheKey, active, {
      ttl: active
        ? SUBSCRIPTION_CACHE_TTL_SECONDS
        : SUBSCRIPTION_DENIED_CACHE_TTL_SECONDS,
    });

    return active;
  };

  private sendForbiddenAccessResponse(res: Response) {
    return ErrorResponse(res, httpStatus.UNAUTHORIZED, {
      message: "Forbidden Access",
    });
  }
}
