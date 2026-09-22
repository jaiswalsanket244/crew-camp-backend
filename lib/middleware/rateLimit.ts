import rateLimit, { ipKeyGenerator, Options } from "express-rate-limit";
import { Request, Response } from "express";
import { ErrorResponse } from "../utils/helpers/apiResponse";
import { RedisRateLimitStore } from "./rateLimitStore";
import { ApiKeyAuthenticatedRequest } from "./apiKeyAuth";

const requestRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 240,
  message: "Too many requests, please try again after a minute.",
  standardHeaders: true,
  legacyHeaders: false,
});

// express-rate-limit replies with a plain-text body by default, which clients
// can't parse like the rest of the API. Emit the standard error envelope so a
// 429 is handled by the same code path as any other failure.
const rateLimitHandler = (
  _req: Request,
  res: Response,
  _next: unknown,
  options: Options,
) => {
  return ErrorResponse(res, options.statusCode, {
    message: String(options.message),
  });
};

// Derives the OTP limiter key: target email/phone, falling back to IP so a
// single recipient can't be flooded regardless of the source IP.
const getOtpRateKey = (req: Request): string => {
  const email =
    typeof req.body?.email === "string"
      ? req.body.email.toLowerCase().trim()
      : "";
  const phone =
    typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  return email || phone || ipKeyGenerator(req.ip ?? "");
};

// Strict limiter for OTP-sending endpoints to prevent email/SMS OTP spamming.
// Keyed by the target email/phone (falling back to IP) so a single
// recipient can't be flooded regardless of the source IP.
const otpRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  message: "Too many OTP requests, please try again after a few minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getOtpRateKey,
  handler: rateLimitHandler,
});

// Caps account-creation floods from a single source. Kept loose enough that a
// crew signing up together behind one office NAT isn't throttled, but tight
// enough that a scripted signer-upper can't mint accounts in bulk.
const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "Too many signup attempts, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// Guards OTP verification against brute force. A 5-digit code is trivially
// guessable with unlimited attempts, and verify-otp hands back a session token
// for existing users, so this is an account-takeover control as well as an
// anti-bot one. Keyed by the target email/phone so an attacker can't spread
// attempts on one victim across many IPs.
const otpVerifyRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: "Too many verification attempts, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getOtpRateKey,
  handler: rateLimitHandler,
});

// NOTE: the default store is in-memory, so the effective ceiling is per
// process. Move to a shared store if this ever needs to be an exact budget.
const aiGenerationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "Too many generation requests. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const user = (req as Request & { user?: { _id?: string } }).user;
    return String(user?._id ?? "") || ipKeyGenerator(req.ip ?? "");
  },
  handler: rateLimitHandler,
});

// Per-API-key budgets for the external API. The per-IP limiter above stays in
// front of these as an outer guard: it is the only thing protecting the auth
// path itself, which runs before a key is known.
const EXTERNAL_API_MAX_PER_MINUTE = 240;
const EXTERNAL_API_WRITE_MAX_PER_MINUTE = 60;

// Falls back to the caller's IP only when the key is somehow absent; these
// limiters are always mounted after ApiKeyMiddleware, so that is a safety net
// rather than a normal path.
const getApiKeyRateKey = (req: Request): string => {
  const keyId = (req as ApiKeyAuthenticatedRequest).apiKey?.keyId;
  return keyId ? String(keyId) : ipKeyGenerator(req.ip ?? "");
};

// Whole-surface budget for one API key, shared across processes via Redis.
const externalApiRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: EXTERNAL_API_MAX_PER_MINUTE,
  message: "Too many requests for this API key, please try again shortly.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getApiKeyRateKey,
  handler: rateLimitHandler,
  store: new RedisRateLimitStore("v1"),
});

// Tighter budget on writes. A runaway integrator sync loop otherwise spends the
// whole allowance creating posts, each of which pushes a notification to every
// member of the project.
const externalApiWriteRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: EXTERNAL_API_WRITE_MAX_PER_MINUTE,
  message: "Too many write requests for this API key, please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getApiKeyRateKey,
  handler: rateLimitHandler,
  skip: (req: Request) => req.method === "GET" || req.method === "HEAD",
  store: new RedisRateLimitStore("v1-write"),
});

export {
  requestRateLimiter,
  otpRateLimiter,
  signupRateLimiter,
  otpVerifyRateLimiter,
  aiGenerationRateLimiter,
  externalApiRateLimiter,
  externalApiWriteRateLimiter,
};
