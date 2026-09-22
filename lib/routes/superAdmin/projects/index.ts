// NPM Deps
import * as express from "express";

// Internal Deps
import { ProjectsRoutes } from "./routes";

export class ProjectsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/", ProjectsRoutes.get)
    this.router.get("/members", ProjectsRoutes.members)
  }
}
