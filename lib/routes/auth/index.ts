import * as express from "express";
import { AuthRoutes } from "./routes";
import {
  otpRateLimiter,
  otpVerifyRateLimiter,
  signupRateLimiter,
} from "../../middleware/rateLimit";
import { turnstileMiddleware } from "../../middleware/turnstile";

export class AuthRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.post("/social-signup", AuthRoutes.registerLoginOauth);
    // No Turnstile here on purpose: the web clients don't attach a token to
    // /register today, and adding the gate would 403 every web signup. The
    // entry point of the flow (request-otp) is already Turnstile-gated, and
    // register now requires a completed OTP, so web bots are stopped upstream.
    this.router.post("/register", signupRateLimiter, AuthRoutes.register);
    // this.router.post(
    //   "/register-with-email-password",
    //   signupRateLimiter,
    //   turnstileMiddleware,
    //   AuthRoutes.registerWithEmailPassword,
    // );
    this.router.post(
      "/login-with-email-password",
      AuthRoutes.loginWithEmailPassword,
    );
    this.router.post("/login", AuthRoutes.login);
    // this.router.post("/reset-password", AuthRoutes.sendResetEmail);
    // this.router.get("/reset-password/:token", AuthRoutes.resetPasswordRedirect);
    // this.router.post("/update-password", AuthRoutes.updatePassword);
    this.router.put("/:id/unsubscribe", AuthRoutes.unsubscribe);
    // this.router.put(
    //   "/delete-firebase-user/:uid",
    //   AuthRoutes.deleteFirebaseUser,
    // );
    this.router.post(
      "/request-otp",
      otpRateLimiter,
      turnstileMiddleware,
      AuthRoutes.requestOtp,
    );
    this.router.post(
      "/resend-otp",
      otpRateLimiter,
      turnstileMiddleware,
      AuthRoutes.resendOtp,
    );
    this.router.post("/verify-otp", otpVerifyRateLimiter, AuthRoutes.verifyOtp);
    // this.router.post("/two-factor-enable", AuthRoutes.twoFactorEnabled);
    // this.router.post("/two-factor-verify", AuthRoutes.twoFactorVerify);
    // this.router.post("/two-factor-login", AuthRoutes.twoFactorLogin);
  }
}
