import * as express from "express";
import { TagsRoutes } from "../../../tags/routes";

export class TagsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();

    this.router.get("/", TagsRoutes.getTags);
  }
}
