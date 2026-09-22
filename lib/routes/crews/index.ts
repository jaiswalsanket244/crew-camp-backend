import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { CrewsRoutes } from "./routes";

const middleware = new Middleware();

export class CrewsRouters {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.authMiddleware);
    this.router.get("/", CrewsRoutes.getAllCrews);
    this.router.get("/list", CrewsRoutes.getCrewList);
    this.router.get("/allMembers", CrewsRoutes.getCompanyMembers);
    this.router.get("/:crewId/details", CrewsRoutes.getCrewDetails);
    this.router.post("/", CrewsRoutes.createCrew);
    this.router.put("/:crewId", CrewsRoutes.updateCrew);
    this.router.put("/:crewId/members", CrewsRoutes.updateMembers);
    this.router.put("/:crewId/delete-crew", CrewsRoutes.deleteCrew);
    this.router.put("/:crewId/projects", CrewsRoutes.updateCrewProject);
  }
}
