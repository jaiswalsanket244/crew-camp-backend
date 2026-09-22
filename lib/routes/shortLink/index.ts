import * as express from "express";
import { ShortLinkRoutes } from "./routes";
export class ShortLinkRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/:id", ShortLinkRoutes.getFullUrl);
  }
}
