import * as express from "express";
import { LikesRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

export class LikesRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.get("/", LikesRoutes.like);
  }
}
