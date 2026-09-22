/**
 * Integration Router
 *
 * All routes require authentication.
 * Admin role required for connect/disconnect/settings operations.
 */

import * as express from "express";
import { IntegrationRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

const middleware = new Middleware();

export class IntegrationRouter {
  router: express.Router;

  constructor() {
    this.router = express.Router();

    //CompanyCam Data import
    this.router.post(
      "/companycam/verify",
      IntegrationRoutes.verifyDataFromCompanyCam,
    );

    this.router.post(
      "/companycam/import",
      IntegrationRoutes.importDataFromCompanyCam,
    );

    // All integration routes require authentication
    this.router.use(middleware.jwtDecoder);

    this.router.use(middleware.authMiddleware);

    // List available providers (any authenticated user)
    this.router.get("/providers", IntegrationRoutes.getProviders);

    // Get integration status (any authenticated user)
    this.router.get("/status", IntegrationRoutes.getStatus);

    // Get sync history (any authenticated user)
    this.router.get("/sync-history", IntegrationRoutes.getSyncHistory);

    // Admin-only operations
    this.router.post("/add", IntegrationRoutes.connect);
    this.router.put("/changeStatus/:id", IntegrationRoutes.changeStatus);
    this.router.patch("/settings", IntegrationRoutes.updateSettings);
    this.router.post("/test", IntegrationRoutes.testConnection);
    this.router.post("/sync-tags", IntegrationRoutes.syncTagDefinitions);
    this.router.post("/retry", IntegrationRoutes.retrySyncJob);
  }
}
