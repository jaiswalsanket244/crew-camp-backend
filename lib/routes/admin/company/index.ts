import * as express from "express";
import { Middleware } from "../../../middleware/auth";
import { CompanyRoutes } from "./routes";
export class CompanyRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().superAdminMiddleware);
    this.router.get("/", CompanyRoutes.getCompanies);
    this.router
      .get("/:id", CompanyRoutes.getCompanyDetails)
      .put("/:id", CompanyRoutes.editCompany);
    this.router.get("/users/:id", CompanyRoutes.getCompanyUsers);
    this.router.put("/change-user-role/:id", CompanyRoutes.changeUserRole);
  }
}
