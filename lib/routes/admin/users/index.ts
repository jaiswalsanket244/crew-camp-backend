// NPM Deps
import * as express from "express";

// Internal Deps
import { AdminUsersRoutes } from "./routes";
import { Middleware } from "../../../middleware/auth";
export class AdminUsersRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().adminMiddleware);
    this.router
      .get("/", AdminUsersRoutes.get)
      .get("/:id", AdminUsersRoutes.getOne);
  }
}
