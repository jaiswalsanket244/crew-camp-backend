import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { GalleryRoutes } from "./router";
const middleware = new Middleware();

export class GalleryRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/:id", GalleryRoutes.get);
    this.router.use(middleware.authMiddleware);
    this.router.post("/", GalleryRoutes.create);
  }
}
