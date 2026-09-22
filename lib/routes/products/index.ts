// NPM Deps
import * as express from "express";

// Internal Deps
import { ProductsRoutes } from "./routes";
import { Middleware } from "../../middleware/auth";

const middleware = new Middleware();
export class ProductsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.authMiddleware);
    this.router.get("/", ProductsRoutes.get).post("/", ProductsRoutes.create);
    this.router
      .get("/:id", ProductsRoutes.getOne)
      .put("/:id", ProductsRoutes.update)
      .delete("/:id", ProductsRoutes.delete);
  }
}
