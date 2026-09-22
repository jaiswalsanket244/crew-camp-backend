import * as express from "express";
import { ProjectRoutes } from "../../../projects/routes";
import { ExternalProjectRoutes } from "./routes";

export class ProjectRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();

    this.router.get("/", ProjectRoutes.getAllData);
    this.router.get("/details", ProjectRoutes.getProjectDetails);
    this.router.get("/members", ProjectRoutes.getMembers);
    this.router.post("/", ExternalProjectRoutes.create);
    this.router.put("/", ExternalProjectRoutes.update);
  }
}
