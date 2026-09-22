import * as express from "express";
import { SubscriptionRoutes } from "./routes";

import { Middleware } from "../../middleware/auth";

export class StripeSubscriptionRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/success", SubscriptionRoutes.success);
    this.router.use(new Middleware().authMiddleware);
    this.router.get("/history", SubscriptionRoutes.getHistory);
    this.router.get(
      "/session/:sessionId",
      SubscriptionRoutes.getSessionDetails,
    );
    this.router.get("/plans", SubscriptionRoutes.getAllStripeSubscripitonPlans);
    this.router.get("/", SubscriptionRoutes.getUserPlans); // get all plans of the user.
    this.router.post(
      "/customer/create",
      SubscriptionRoutes.createStripeCustomer,
    );
    this.router.post("/", SubscriptionRoutes.createSubscription);
    this.router.put("/cancel", SubscriptionRoutes.cancelSubscription);
    this.router.post("/upgrade", SubscriptionRoutes.upgradeSubscription);
    this.router.post("/downgrade", SubscriptionRoutes.downgradeSubscription);
    this.router.get("/products", SubscriptionRoutes.getStripeProducts);
    this.router.post("/payment", SubscriptionRoutes.createPaymentLink);
    this.router.post(
      "/billing-portal",
      SubscriptionRoutes.createBillingPortalSession,
    );
  }
}
