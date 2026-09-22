import * as express from "express";
import { AdminUsersRouter } from "./users";
import { InviteUsersRouter } from "./invitedUsers";
import { PaymentRouter } from "./payments";
import { RefundsRouter } from "./refund";
import { CompanyRouter } from "./company";
import { ProductsRouter } from "./products";
import { SubscriptionRouter } from "./subscription";
import { AdminSearchRouter } from "./search";
export class AdminRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use("/user", new AdminUsersRouter().router);
    this.router.use("/invite-users", new InviteUsersRouter().router);
    this.router.use("/payments", new PaymentRouter().router);
    this.router.use("/refunds", new RefundsRouter().router);
    this.router.use("/company", new CompanyRouter().router);
    this.router.use("/products", new ProductsRouter().router);
    this.router.use("/subscription", new SubscriptionRouter().router);
    this.router.use("/search", new AdminSearchRouter().router);
  }
}
