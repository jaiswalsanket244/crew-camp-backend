import * as express from "express";
import { AwsRoutes } from "../../../aws/routes";
import { ExternalUploadRoutes } from "./routes";

export class UploadRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();

    // Single-PUT uploads — the normal path for photos.
    this.router.post("/presigned-url", ExternalUploadRoutes.getPreSignedUrl);
    this.router.post(
      "/multi-presigned-url",
      ExternalUploadRoutes.getMultiPreSignedUrl,
    );

    // Multipart uploads — required for videos above the single-PUT limit.
    // Initiate and abort are handled here rather than delegated, because both
    // need to touch the upload tracking the orphan sweep reads.
    this.router.post(
      "/multipart/initiate",
      ExternalUploadRoutes.initiateMultipart,
    );
    this.router.post("/multipart/part-urls", AwsRoutes.getPartUrls);
    this.router.post("/multipart/complete", AwsRoutes.completeMultipart);
    this.router.get("/multipart/parts", AwsRoutes.listParts);
    this.router.post("/multipart/abort", ExternalUploadRoutes.abortMultipart);
  }
}
