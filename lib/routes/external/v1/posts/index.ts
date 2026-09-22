import * as express from "express";
import { PostsRoutes } from "../../../posts/routes";
import { ExternalPostRoutes } from "./routes";

export class PostRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();

    this.router.get("/", PostsRoutes.getPosts);
    this.router.post("/", ExternalPostRoutes.create);
    this.router.put("/files", ExternalPostRoutes.insertFiles);
  }
}
