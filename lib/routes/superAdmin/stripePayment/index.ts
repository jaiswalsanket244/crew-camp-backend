import * as express from "express";
import { StripePaymentRoutes } from "./routes";

export class StripePaymentRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.get("/charges", StripePaymentRoutes.getAllCharges);
    this.router.get("/sellers", StripePaymentRoutes.getAllSellers);
    this.router.get("/payouts", StripePaymentRoutes.getAllPayouts);
    this.router.post("/create/payout", StripePaymentRoutes.createPayout);
    this.router.get(
      "/seller/charges/:sellerStripeAccountId",
      StripePaymentRoutes.getSellerChargesWithBalance,
    );
  }
}
