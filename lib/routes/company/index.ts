import * as express from "express";
import { CompanyRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

const middleware = new Middleware();

export class CompanyRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    // this.router.use(new Middleware().superAdminMiddleware);
    this.router.post("/create", CompanyRoutes.create);
    this.router.post("/join", CompanyRoutes.join);
    this.router.get("/members", CompanyRoutes.getCompanyUsers);
    this.router.get("/members-list", CompanyRoutes.getCompanyUsersLight);
    this.router.get("/remove", CompanyRoutes.removeAccount);
    this.router.post("/change", CompanyRoutes.changeAccessType);
    this.router.post(
      "/deactivate-member",
      middleware.authMiddleware,
      middleware.adminOrManagerMiddleware,
      CompanyRoutes.deactivateMember,
    );
    this.router.post(
      "/reactivate-member",
      middleware.authMiddleware,
      middleware.adminOrManagerMiddleware,
      CompanyRoutes.reactivateMember,
    );
    this.router.put(
      "/logo",
      middleware.authMiddleware,
      middleware.adminMiddleware,
      CompanyRoutes.updateLogo,
    );
    this.router.get(
      "/show-default-tags",
      middleware.authMiddleware,
      CompanyRoutes.getShowDefaultTags,
    );
    this.router.put(
      "/show-default-tags",
      middleware.authMiddleware,
      middleware.adminMiddleware,
      CompanyRoutes.updateShowDefaultTags,
    );
  }
}
