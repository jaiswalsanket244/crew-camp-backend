import * as express from "express";
import { ErrorLogsRoutes } from "./routes";

export class ErrorLogsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/", ErrorLogsRoutes.list);
  }
}
