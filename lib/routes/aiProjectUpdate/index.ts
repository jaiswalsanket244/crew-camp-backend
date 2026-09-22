import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { AiProjectUpdateRoutes } from "./routes";
import { aiGenerationRateLimiter } from "../../middleware/rateLimit";

const middleware = new Middleware();

// Mirrors DailyLogRouter: the share-link read is registered before the auth
// gate; "/list" is registered before "/:id" so it is not shadowed.
export class AiProjectUpdateRouter {
  router: express.Router;

  constructor() {
    this.router = express.Router();
    this.router.get("/public/:id", AiProjectUpdateRoutes.getPublic);
    this.router.use(middleware.authMiddleware);
    this.router.post(
      "/generate",
      aiGenerationRateLimiter,
      AiProjectUpdateRoutes.generate,
    );
    this.router.get("/list", AiProjectUpdateRoutes.list);
    this.router.post("/", AiProjectUpdateRoutes.create);
    this.router.get("/:id", AiProjectUpdateRoutes.get);
    this.router.put("/:id", AiProjectUpdateRoutes.update);
    this.router.delete("/:id", AiProjectUpdateRoutes.delete);
  }
}
