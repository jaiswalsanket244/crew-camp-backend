import * as httpStatus from "http-status";
import { Request, Response, NextFunction } from "express";
import { ErrorResponse } from "../utils/helpers/apiResponse";
import { TurnstileService } from "../services/turnstile";
import { config } from "../utils/configuration/config";
import { WEB_APP_ORIGINS } from "../utils/constants/constants";

/**
 * Enforces Cloudflare Turnstile verification for first-party web traffic only.
 *
 * Turnstile tokens are issued to the web app; the mobile app doesn't send one,
 * so we gate enforcement on the request Origin being a known web origin. Requests
 * without a web Origin (mobile, server-to-server) pass through and are covered by
 * rate limiting today and app attestation later.
 *
 * Note: Origin is browser-controlled and can't be forged by a real browser, but a
 * scripted client can omit it to be treated as "non-web". This is an accepted
 * trade-off — the rate limiter still applies to those requests.
 *
 * Fails OPEN when TURNSTILE_SECRET_KEY is unset (so environments mid-rollout don't
 * break web login) and CLOSED on a missing/invalid token once the key is configured.
 */
export const turnstileMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const origin = req.headers.origin;
    const isWebRequest = !!origin && WEB_APP_ORIGINS.includes(origin);

    // Non-web clients (mobile / server-to-server) are not gated by Turnstile.
    if (!isWebRequest) {
      return next();
    }

    if (!config.TURNSTILE_SECRET_KEY) {
      console.warn(
        "[turnstile] TURNSTILE_SECRET_KEY is not set — skipping CAPTCHA verification for web request.",
      );
      return next();
    }

    const token =
      (typeof req.body?.turnstileToken === "string" &&
        req.body.turnstileToken) ||
      (req.headers["cf-turnstile-response"] as string) ||
      "";

    if (!token) {
      return ErrorResponse(res, httpStatus.FORBIDDEN, {
        message: "Captcha verification required.",
      });
    }

    const verified = await TurnstileService.verify(token, req.ip);

    if (!verified) {
      return ErrorResponse(res, httpStatus.FORBIDDEN, {
        message: "Captcha verification failed. Please try again.",
      });
    }

    return next();
  } catch (error) {
    return ErrorResponse(res, httpStatus.INTERNAL_SERVER_ERROR, {
      message: "Captcha verification error.",
    });
  }
};
