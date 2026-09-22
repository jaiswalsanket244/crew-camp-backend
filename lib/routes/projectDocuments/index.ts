import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { ProjectDocumentRoutes } from "./routes";

const middleware = new Middleware();

export class ProjectDocumentRouter {
  router: express.Router;

  constructor() {
    this.router = express.Router();
    this.router.use(middleware.authMiddleware);
    this.router.get("/list", ProjectDocumentRoutes.list);
    this.router.patch("/:id/title", ProjectDocumentRoutes.rename);
  }
}
