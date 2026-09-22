import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { DailyLogRoutes } from "./routes";
import { aiGenerationRateLimiter } from "../../middleware/rateLimit";

const middleware = new Middleware();

export class DailyLogRouter {
  router: express.Router;

  constructor() {
    this.router = express.Router();
    this.router.get("/public/:id", DailyLogRoutes.getPublic);
    this.router.use(middleware.authMiddleware);
    this.router.post(
      "/generate",
      aiGenerationRateLimiter,
      DailyLogRoutes.generate,
    );
    this.router.get("/list", DailyLogRoutes.list);
    this.router.post("/", DailyLogRoutes.create);
    this.router.get("/:id", DailyLogRoutes.get);
    this.router.put("/:id", DailyLogRoutes.update);
    this.router.delete("/:id", DailyLogRoutes.delete);
  }
}
