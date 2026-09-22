import * as express from "express";
import { FcmTokensRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";
export class FcmTokensRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.get("/", FcmTokensRoutes.get).post("/", FcmTokensRoutes.create);
    this.router
      .get("/:id", FcmTokensRoutes.getOne)
      .put("/:id", FcmTokensRoutes.update)
      .get("/userTokens", FcmTokensRoutes.getUserTokens)
      .delete("/:token", FcmTokensRoutes.deleteToken);
  }
}
