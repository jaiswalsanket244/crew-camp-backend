// NPM Deps
import * as express from "express";
import { Middleware } from "../../../middleware/auth";

// Internal Deps
import { RefundsRoutes } from "./routes";
export class RefundsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().adminMiddleware);
    this.router
      .get("/", RefundsRoutes.get)
      .post("/", RefundsRoutes.initiateRefund);
    this.router
      .get("/:id", RefundsRoutes.getOne)
      .put("/:id", RefundsRoutes.update)
      .delete("/:id", RefundsRoutes.delete);
  }
}
