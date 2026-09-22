import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { OfflineRoutes } from "./routes";

export class OfflineRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);

    this.router.get("/bundle", OfflineRoutes.getBundle);
  }
}
