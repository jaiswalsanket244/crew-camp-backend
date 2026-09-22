import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { InviteUserRoutes } from "./routes";
export class InviteUserRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.get("/invite", InviteUserRoutes.inviteUser);
  }
}

export class AcceptInviteRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/:inviteCode", InviteUserRoutes.validateLink);
    this.router.get("/guest/:inviteCode/", InviteUserRoutes.validateGuestLink);
  }
}
