import * as express from "express";
import { PaymentRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";
const middleware = new Middleware();

export class PaymentRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.authMiddleware);
    this.router.get("/", PaymentRoutes.getPayments);
    this.router.get("/payment-details/:id", PaymentRoutes.getPaymentsById);
    this.router.get(
      "/user-card-details/:userId",
      PaymentRoutes.getUserCardDetails,
    );
    this.router.post("/change/saved-card", PaymentRoutes.changeSavedCard);
    this.router.post("/charge/create", PaymentRoutes.createCharge);
    this.router.post("/charge/saved-card", PaymentRoutes.chargeSavedCard);
    this.router.get("/saved-card", PaymentRoutes.retrieveSavedCard);
    this.router.post("/charge/guest-card", PaymentRoutes.chargeGuestCard);
    this.router.post("/save-paypal-payment", PaymentRoutes.savePayPalPayment);
    this.router.post("/save-card", PaymentRoutes.saveCard);
    this.router.post("/delete-card", PaymentRoutes.deleteCard);
    this.router.put("/update-card", PaymentRoutes.updateCard);
    this.router.post("/create/intent", PaymentRoutes.createPaymentIntent);
  }
}
