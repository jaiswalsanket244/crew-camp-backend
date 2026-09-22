// NPM Deps
import * as express from "express";
import { JWPlayerRoutes } from "./routes";
export class JWPlayerRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router
      .post("/create-jwuri", JWPlayerRoutes.createJwURl)
      .post("/get-videouri", JWPlayerRoutes.getJWPlayerVideoUrls);
  }
}
