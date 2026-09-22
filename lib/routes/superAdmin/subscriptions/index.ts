// NPM Deps
import * as express from "express";

// Internal Deps
import { SubscriptionRoutes } from "./routes";

export class SubscriptionRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/", SubscriptionRoutes.get);
    this.router.get("/subscribers", SubscriptionRoutes.getSubscriptionData);
    this.router.post("/updateLimit", SubscriptionRoutes.updateTeamLimit);
    this.router.get("/products", SubscriptionRoutes.getStripeProducts);
    this.router.post("/payment", SubscriptionRoutes.createPaymentLink);
    this.router.post("/sendPaymentLink", SubscriptionRoutes.sharePaymentLink);
  }
}
