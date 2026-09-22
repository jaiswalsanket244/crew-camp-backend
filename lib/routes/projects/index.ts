import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { ProjectRoutes } from "./routes";
const middleware = new Middleware();

export class ProjectRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/details", ProjectRoutes.getProjectDetails);
    this.router.use(middleware.authMiddleware);
    this.router.post("/", ProjectRoutes.create);
    this.router.get("/", ProjectRoutes.getMyProjects);
    this.router.get("/map", ProjectRoutes.getMyProjectsMap);
    this.router.get("/mapV2", ProjectRoutes.getMyProjectsMapV2);
    this.router.put("/", ProjectRoutes.update);
    this.router.get("/all", ProjectRoutes.getAllData);
    this.router.get("/list", ProjectRoutes.getAllDataV2);
    this.router.get("/join", ProjectRoutes.join);
    this.router.get("/leave", ProjectRoutes.leave);
    this.router.get("/members", ProjectRoutes.getMembers);
    this.router.get("/user", ProjectRoutes.getUserData);
    this.router.get("/total", ProjectRoutes.getTotalProjects);
    // The caller's pins as { _id, name, pinnedAt } — what the sidebar rail needs, without the
    // per-row fan-out of /list.
    this.router.get("/pinned", ProjectRoutes.getPinned);
    // Pin for the caller only.
    this.router.put("/pin", ProjectRoutes.pin);
    this.router.put("/unpin", ProjectRoutes.unpin);
    // Pin for every active non-guest member of the project — writes into other users' accounts,
    // so admins/managers only.
    this.router.put(
      "/pin-all",
      middleware.adminOrManagerMiddleware,
      ProjectRoutes.pinForAll,
    );
    this.router.put(
      "/unpin-all",
      middleware.adminOrManagerMiddleware,
      ProjectRoutes.unpinForAll,
    );
    this.router.put("/delete", ProjectRoutes.softDelete);
    this.router.put("/archive", ProjectRoutes.archive);
    this.router.put("/unarchive", ProjectRoutes.unarchive);
    // Duplicate consolidation — admins/managers only (company role re-checked per project).
    this.router.get(
      "/merge/preview",
      middleware.adminOrManagerMiddleware,
      ProjectRoutes.mergePreview,
    );
    this.router.post(
      "/merge",
      middleware.adminOrManagerMiddleware,
      ProjectRoutes.merge,
    );
    this.router.get("/people", ProjectRoutes.getPeople);
    this.router.get("/search", ProjectRoutes.getSearchResults);
    this.router.get("/tab-counts", ProjectRoutes.getTabCounts);
    this.router.post("/pdf", ProjectRoutes.getImagesPdf);
  }
}
