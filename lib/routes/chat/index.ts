import * as express from "express";
import { ChatRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

export class ChatRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.get("/search-users", ChatRoutes.searchUser);
    this.router.post("/add-users-info", ChatRoutes.addUserDataToQuery);
  }
}
