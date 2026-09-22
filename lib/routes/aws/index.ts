import * as express from "express";
import { AwsRoutes } from "./routes";

export class AwsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    // Single-PUT endpoints.
    this.router.post("/presigned-url", AwsRoutes.getPreSignedUrl);
    this.router.post("/multi-presigned-url", AwsRoutes.getMultiPreSignedUrl);

    // Multipart endpoints.
    this.router.post("/multipart/initiate", AwsRoutes.initiateMultipart);
    this.router.post("/multipart/part-urls", AwsRoutes.getPartUrls);
    this.router.post("/multipart/complete", AwsRoutes.completeMultipart);
    this.router.get("/multipart/parts", AwsRoutes.listParts);
    this.router.post("/multipart/abort", AwsRoutes.abortMultipart);
  }
}
