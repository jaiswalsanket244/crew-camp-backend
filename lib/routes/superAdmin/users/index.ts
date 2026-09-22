// NPM Deps
import * as express from "express";

// Internal Deps
import { UsersRoutes } from "./routes";

export class UsersRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router
      .get("/", UsersRoutes.get)
      .get("/check", UsersRoutes.checkAccount)
      .get("/graph", UsersRoutes.getActiveUserGraph)
      .get("/:id", UsersRoutes.getOne);
    this.router.post("/create", UsersRoutes.createAccount)
    this.router.delete("/", UsersRoutes.deleteAccount)
  }
}
