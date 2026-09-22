import * as express from "express";
import { PostsRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

export class PostRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/postdata", PostsRoutes.getPostData);
    this.router.get("/scroll", PostsRoutes.getPostDataForScroll);
    this.router.get("/scroll/v2", PostsRoutes.getPostDataForScrollV2);
    this.router.get("/uploads", PostsRoutes.getUploads);
    this.router.get("/uploads/v2", PostsRoutes.getUploadsV2);
    this.router.get("/recentUploads", PostsRoutes.getRecentUploads);
    this.router.use(new Middleware().authMiddleware);
    this.router.post("/", PostsRoutes.create);
    this.router.get("/", PostsRoutes.getPosts);
    this.router.get("/:id/files", PostsRoutes.getPostFiles);
    this.router.get("/search", PostsRoutes.getSearchRecommendation);
    this.router.post("/report", PostsRoutes.reportPost);
    this.router.put("/", PostsRoutes.update);
    this.router.put("/file", PostsRoutes.insertFileInPost);
    this.router.put("/files/batch", PostsRoutes.insertFilesInPost);
    this.router.delete("/file", PostsRoutes.deleteFile);
    this.router.delete("/files", PostsRoutes.deleteFiles);
    this.router.delete(
      "/files/unfinalized",
      PostsRoutes.deleteUnfinalizedFiles,
    );
    this.router.put("/tags", PostsRoutes.updateTags);
    this.router.put("/tags/bulk", PostsRoutes.bulkUpdateTags);
    this.router.put("/file/description", PostsRoutes.updateFileDescription);
    this.router.post("/replace", PostsRoutes.replaceOriginalFile);
    this.router.post("/saveAsCopy", PostsRoutes.saveFileAsCopy);
    this.router.post("/file/revert", PostsRoutes.revertFileToOriginal);
    this.router.post("/move", PostsRoutes.moveFileToAnotherProject);
  }
}
