import * as express from "express";
import { FileRoutes } from "./routes";
import { upload } from "../../services/multerConfig";
import { Middleware } from "../../middleware/auth";

const middleware = new Middleware();
export class FileRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.post("/upload", upload, FileRoutes.upload);
    this.router.delete("/delete", FileRoutes.delete);
    this.router.get("/proxy", FileRoutes.proxy);
    this.router.get("/download", FileRoutes.downloadFile);
    this.router.use(middleware.authMiddleware);
    this.router.post("/presigned-url", FileRoutes.getPreSignedUrl);
    this.router.get("/", FileRoutes.getFiles);
    this.router.post("/", FileRoutes.create);
    this.router.put("/", FileRoutes.updateFile);
    this.router.delete("/:id", FileRoutes.deleteFile);
  }
}
