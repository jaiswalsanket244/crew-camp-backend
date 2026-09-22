import * as express from "express";
import { ChecklistRoutes } from "../../../checklist/routes";
import { ExternalChecklistRoutes } from "./routes";

export class CheckListRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();

    this.router.get("/", ChecklistRoutes.getChecklists);
    this.router.get("/details", ChecklistRoutes.getChecklistDetails);
    this.router.post("/", ExternalChecklistRoutes.create);
  }
}
