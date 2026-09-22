import * as express from "express";
import { Middleware } from "../../../middleware/auth";
import { ProductsRoutes } from "./routes";

const middleware = new Middleware();
export class ProductsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(middleware.adminMiddleware);
    this.router.get("/", ProductsRoutes.get).post("/", ProductsRoutes.create);
    this.router
      .get("/:id", ProductsRoutes.getOne)
      .put("/:id", ProductsRoutes.update)
      .delete("/:id", ProductsRoutes.delete);
  }
}
