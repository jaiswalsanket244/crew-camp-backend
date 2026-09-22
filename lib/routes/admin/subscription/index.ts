import * as express from "express";
import { SubscriptionRoutes } from "./routes";

import { Middleware } from "../../../middleware/auth";
const middleware = new Middleware();

export class SubscriptionRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.adminMiddleware);
    this.router.get("/", SubscriptionRoutes.getAllSubscribedUsers); // get all users data who purchased subscription
  }
}
