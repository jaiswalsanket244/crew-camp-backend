import * as express from "express";
import { ProjectNotesRoutes } from "../../../projectNotes/routes";
import { ExternalProjectNotesRoutes } from "./routes";

export class ProjectNotesRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();

    this.router.get("/", ProjectNotesRoutes.getNotesByProjectId);
    this.router.post("/", ExternalProjectNotesRoutes.create);
    this.router.put("/", ExternalProjectNotesRoutes.update);
    this.router.delete("/", ExternalProjectNotesRoutes.delete);
  }
}
