// NPM Deps
import * as express from "express";
import { Middleware } from "../../middleware/auth";

// Internal Deps
import { RefundRoutes } from "./routes";

const middleware = new Middleware();
export class RefundRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.authMiddleware);
    this.router.get("/", RefundRoutes.getAllPayments);
    this.router.post("/", RefundRoutes.create);
  }
}
