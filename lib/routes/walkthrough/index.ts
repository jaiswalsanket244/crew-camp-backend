import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { WalkthroughRoutes } from "./routes";
import { audioUpload } from "../../middleware/upload";

const middleware = new Middleware();

export class WalkthroughRouter {
  router: express.Router;

  constructor() {
    this.router = express.Router();
    this.router.use(middleware.authMiddleware);
    this.router.post("/generate-report", WalkthroughRoutes.generateReport);
    this.router.post(
      "/process-and-generate",
      audioUpload,
      WalkthroughRoutes.processAndGenerate,
    );
  }
}
