// NPM Deps
import * as express from "express";

// Internal Deps
import { HealthRoutes } from "./routes";

export class HealthRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.post("/cache/refresh", HealthRoutes.refreshCache);
    this.router.get("/overview", HealthRoutes.overview);
    this.router.get("/releases", HealthRoutes.releases);
    this.router.get("/users", HealthRoutes.users);
    this.router.get("/breakdown", HealthRoutes.breakdown);
    this.router.get("/stuck-uploads", HealthRoutes.stuckUploads);
    this.router.get("/subject", HealthRoutes.subject);
    this.router.get("/event", HealthRoutes.event);
    this.router.get("/camera", HealthRoutes.camera);
    this.router.get("/camera/devices", HealthRoutes.cameraDevices);
    this.router.get("/camera/device", HealthRoutes.cameraDeviceIssues);
    this.router.get("/crash-free", HealthRoutes.crashFree);
    this.router.get("/crashes/devices", HealthRoutes.crashedDevices);
    this.router.get("/crashes/device", HealthRoutes.deviceCrashes);
    this.router.get("/crashes/impact", HealthRoutes.crashImpact);
  }
}
