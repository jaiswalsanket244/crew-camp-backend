import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { TagsRoutes } from "./routes";
const middleware = new Middleware();

export class TagsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/", TagsRoutes.getTags);
    this.router.get("/project/:id", TagsRoutes.getProjectsTags);
    this.router.use(middleware.authMiddleware);
    this.router.post("/", TagsRoutes.create);
    this.router.post("/:id", TagsRoutes.editTags);
    this.router.delete("/:id", TagsRoutes.deleteTag);
  }
}
