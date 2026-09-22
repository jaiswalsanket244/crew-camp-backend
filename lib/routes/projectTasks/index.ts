import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { ProjectTaskRoutes } from "./routes";
const middleware = new Middleware();

export class ProjectTasksRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/", ProjectTaskRoutes.getTasks);
    this.router.use(middleware.authMiddleware);
    // Must stay below authMiddleware — "mine" is resolved from req.user.
    this.router.get("/mine", ProjectTaskRoutes.getMyTasks);
    this.router.post("/", ProjectTaskRoutes.create);
    this.router.put("/status", ProjectTaskRoutes.updateStatus);
    this.router.put("/", ProjectTaskRoutes.update);
    this.router.put("/manage", ProjectTaskRoutes.manage);
  }
}
