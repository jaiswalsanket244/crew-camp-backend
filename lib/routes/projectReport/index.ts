import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { ProjectReportsRoutes } from "./routes";
const middleware = new Middleware();

export class ProjectReportsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/report/:id", ProjectReportsRoutes.get);
    this.router.get("/list", ProjectReportsRoutes.getReportList);
    this.router.use(middleware.authMiddleware);
    // Authenticated, membership-scoped cross-project report list.
    this.router.get("/list/all", ProjectReportsRoutes.getAllList);
    // Personal View — authenticated cross-project "my reports".
    // After authMiddleware; no GET /:param route above to shadow it.
    this.router.get("/mine", ProjectReportsRoutes.getMyReports);
    this.router.post("/", ProjectReportsRoutes.create);
    this.router.put("/:id", ProjectReportsRoutes.update);
    this.router.delete("/:id", ProjectReportsRoutes.delete);
  }
}
