import * as express from "express";
import { WebhookRoutes } from "./routes";
export class WebhookRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.post("/", WebhookRoutes.subscriptionWebhook);
    this.router.post("/stripe", WebhookRoutes.stripeWebhook);
    // CRM integration webhooks
    this.router.post("/jobnimbus", WebhookRoutes.jobnimbusWebhook);
    this.router.post("/proline", WebhookRoutes.prolineWebhook);
  }
}
