import * as express from "express";
import { ReviewRoutes } from "./routes";

export class ReviewRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.post("/", ReviewRoutes.create);
  }
}
