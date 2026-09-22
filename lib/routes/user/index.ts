import * as express from "express";
import { UserRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";
import { upload } from "../../services/multerConfig";
import { otpRateLimiter } from "../../middleware/rateLimit";
import { turnstileMiddleware } from "../../middleware/turnstile";

const middleware = new Middleware();

export class UserRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.post(
      "/otp",
      otpRateLimiter,
      turnstileMiddleware,
      UserRoutes.getOtp,
    );
    this.router.post("/verify-delete", UserRoutes.verifyAndDelete);
    this.router.use(middleware.authMiddleware);
    this.router.get("/me", UserRoutes.me);
    this.router.put("/updateSettings", UserRoutes.updateSettings);
    this.router.put("/profile", upload, UserRoutes.updateProfile);
    this.router.post(
      "/change-contact/reauth/request",
      UserRoutes.requestContactChangeReauth,
    );
    this.router.post(
      "/change-contact/reauth/verify",
      UserRoutes.verifyContactChangeReauth,
    );
    this.router.post(
      "/change-contact/request",
      UserRoutes.requestContactChange,
    );
    this.router.post("/change-contact/verify", UserRoutes.verifyContactChange);
    this.router.post("/change-password", UserRoutes.changePassword);
    this.router.delete("/delete", UserRoutes.deleteAccount);
    this.router.put(
      "/updateRole",
      middleware.adminOrManagerMiddleware,
      UserRoutes.updateRole,
    );
  }
}
