import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { ChecklistRoutes } from "./routes";
const middleware = new Middleware();

export class CheckListRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/", ChecklistRoutes.getChecklists);
    this.router.get("/pdf/:checklistId", ChecklistRoutes.exportPDF);
    this.router.use(middleware.authMiddleware);
    this.router.get("/details", ChecklistRoutes.getChecklistDetails);
    this.router.post("/", ChecklistRoutes.create);
    this.router.put("/status", ChecklistRoutes.updateStatus);
    this.router.put("/", ChecklistRoutes.update);
    this.router.delete("/:id", ChecklistRoutes.delete);
    this.router.put("/complete", ChecklistRoutes.completeCheckList);
    this.router.put("/pending", ChecklistRoutes.inProgressCheckList);
    this.router.put("/questionValue", ChecklistRoutes.updateTodoQuestionValue);
    this.router.put("/status/v2", ChecklistRoutes.updateStatusV2);
    this.router.get("/details/v2", ChecklistRoutes.getChecklistDetailsV2);
    // V2 typed fields
    this.router.get("/v2", ChecklistRoutes.getChecklistsV2);
    this.router.post("/v2", ChecklistRoutes.createV2);
    this.router.put("/v2", ChecklistRoutes.updateV2);
    this.router.get("/details/v3", ChecklistRoutes.getChecklistDetailsV3);
    this.router.patch("/v2/response", ChecklistRoutes.saveFieldResponse);
  }
}
