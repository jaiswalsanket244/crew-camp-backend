import * as express from "express";
import { Middleware } from "../../../middleware/auth";
import { AdminSearchRoutes } from "./routes";

const middleware = new Middleware();
export class AdminSearchRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    // Per-route gating: /status is admin, /flag is super-admin. adminMiddleware and superAdminMiddleware are mutually-exclusive exact role matches, so they CANNOT both be applied router-wide — gate each route individually.
    this.router.get(
      "/status",
      middleware.adminMiddleware,
      AdminSearchRoutes.getStatus,
    );
    this.router.post(
      "/flag",
      middleware.superAdminMiddleware,
      AdminSearchRoutes.setFlag,
    );
    this.router.post(
      "/reindex",
      middleware.superAdminMiddleware,
      AdminSearchRoutes.enqueueReindex,
    );
    this.router.post(
      "/default",
      middleware.superAdminMiddleware,
      AdminSearchRoutes.setRouteDefault,
    );
  }
}
