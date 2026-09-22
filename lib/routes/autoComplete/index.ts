// NPM Deps
import * as express from "express";
import { Middleware } from "../../middleware/auth";

// Internal Deps
import { AutoCompleteRoutes } from "./routes";

const middleware = new Middleware();
export class AutoCompleteRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.authMiddleware);
    this.router.get("/", AutoCompleteRoutes.get);
  }
}
