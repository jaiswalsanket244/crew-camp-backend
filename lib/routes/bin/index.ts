import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { BinRoutes } from "./routes";

export class BinRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);

    this.router.get("/projects", BinRoutes.getProjects);
    this.router.put("/projects", BinRoutes.revertDeletedProject);
    this.router.delete("/projects", BinRoutes.deleteProjectPermanently);

    this.router.get("/posts", BinRoutes.getPosts);
    this.router.put("/posts", BinRoutes.revertDeletedPost);
    this.router.delete("/posts", BinRoutes.deletePostPermanently);

    this.router.get("/tasks", BinRoutes.getTasks);
    this.router.put("/tasks", BinRoutes.revertDeletedTask);
    this.router.delete("/tasks", BinRoutes.deleteTaskPermanently);

    this.router.get("/checklists", BinRoutes.getDeletedChecklists);
    this.router.put("/checklists", BinRoutes.revertDeletedChecklist);
    this.router.delete("/checklists", BinRoutes.deleteChecklistPermanently);

    this.router.get("/reports", BinRoutes.getDeletedReports);
    this.router.put("/reports", BinRoutes.revertDeletedReport);
    this.router.delete("/reports", BinRoutes.deleteReportPermanently);

    this.router.get("/files", BinRoutes.getDeletedFiles);
    this.router.put("/files", BinRoutes.revertDeletedFile);
    this.router.delete("/files", BinRoutes.deleteFilesPermanently);

    this.router.get("/post-files", BinRoutes.getDeletedPostFiles);
    this.router.put("/post-files", BinRoutes.revertDeletedPostFile);
    this.router.delete("/post-files", BinRoutes.deletePostFilesPermanently);
  }
}
