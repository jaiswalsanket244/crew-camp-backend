import * as express from "express";
import { EmailRoutes } from "./routes";
export class EmailRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.post("/contact-form", EmailRoutes.contactForm);
  }
}
