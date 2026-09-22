import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { ProjectNotesRoutes } from "./routes";
const middleware = new Middleware();

export class ProjectNotesRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/", ProjectNotesRoutes.getMyProjectNotes);
    this.router.use(middleware.authMiddleware);
    this.router.post("/", ProjectNotesRoutes.create);
    this.router.delete("/", ProjectNotesRoutes.deleteNote);
    this.router.put("/", ProjectNotesRoutes.update);
  }
}
