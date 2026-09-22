import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { ReportsRoutes } from "./routes";
export class ReportsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.get("/", ReportsRoutes.getReports);
    this.router.get("/report", ReportsRoutes.getReportData);
    this.router.get("/read", ReportsRoutes.readReport);
    this.router.get("/markAllAsRead", ReportsRoutes.markAllAsRead);
    this.router.delete("/post", ReportsRoutes.deletePost);
    this.router.post("/ignore", ReportsRoutes.ingorePost);
  }
}
