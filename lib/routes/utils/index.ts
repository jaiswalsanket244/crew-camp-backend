// NPM Deps
import * as express from "express";
import { UtilsRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";
export class UtilsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.get("/collections", UtilsRoutes.findAllCollections);
    this.router.get("/sidebarItem", UtilsRoutes.findAllSidebarItems);
    this.router.get("/geoCoding", UtilsRoutes.getAddressFromCoordinates);
  }
}
