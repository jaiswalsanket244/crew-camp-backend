import * as express from "express";
import { ApiKeysRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

export class ApiKeyRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.use(new Middleware().adminMiddleware);

    this.router.post("/", ApiKeysRoutes.createApiKey);
    this.router.put("/status/:id", ApiKeysRoutes.toggleApiKey);
    this.router.get("/", ApiKeysRoutes.getUserApiKeys);
    this.router.delete("/:id", ApiKeysRoutes.deleteApiKey);
  }
}
