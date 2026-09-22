import * as express from "express";
import { TwilioRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

export class TwilioRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.post("/send", TwilioRoutes.send);
  }
}
