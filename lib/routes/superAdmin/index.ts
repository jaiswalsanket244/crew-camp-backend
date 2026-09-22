import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { UsersRouter } from "./users";
import { SubscriptionRouter } from "./subscriptions";
import { ProjectsRouter } from "./projects";
import { HealthRouter } from "./health";

const middleware = new Middleware();
export class SuperAdminRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.superAdminMiddleware);
    this.router.use("/users", new UsersRouter().router);
    this.router.use("/subscription", new SubscriptionRouter().router);
    this.router.use("/projects", new ProjectsRouter().router);
    this.router.use("/health", new HealthRouter().router);
  }
}
