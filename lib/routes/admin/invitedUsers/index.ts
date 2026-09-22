import * as express from "express";
import { Middleware } from "../../../middleware/auth";
import { InviteUserRoutes } from "./routes";
const middleware = new Middleware();
export class InviteUsersRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.adminMiddleware);
    this.router.get("/", InviteUserRoutes.getAllInvitedUser);
    this.router.post("/invite", InviteUserRoutes.inviteUser);
  }
}
