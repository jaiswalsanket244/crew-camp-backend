import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { SheetRoutes } from "./routes";

const middleware = new Middleware();

export class SheetRouter {
  router: express.Router;

  constructor() {
    this.router = express.Router();
    this.router.get("/public/:id", SheetRoutes.getPublic);
    this.router.use(middleware.authMiddleware);
    this.router.post("/", SheetRoutes.create);
    this.router.get("/:id", SheetRoutes.get);
    this.router.put("/:id", SheetRoutes.update);
    this.router.delete("/:id", SheetRoutes.delete);
  }
}
