import * as express from "express";
import { CommentRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

export class CommentRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/", CommentRoutes.getComments);
    this.router.use(new Middleware().authMiddleware);
    this.router.post("/", CommentRoutes.create);
    this.router.put("/:id", CommentRoutes.updateComment);
    this.router.delete("/:id", CommentRoutes.deleteComment);
  }
}
