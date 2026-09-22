import * as express from "express";
import { Middleware } from "../../middleware/auth";
import { NotificationsRoutes } from "./routes";
export class NotificationsRouter {
  router: express.Router;
  constructor() {
    this.router = express.Router();
    this.router.use(new Middleware().authMiddleware);
    this.router.get("/read", NotificationsRoutes.markAsRead);
    this.router.get("/markAllAsRead", NotificationsRoutes.markAllAsRead);
    this.router.get("/unreadCount", NotificationsRoutes.getUnreadCount);
    this.router
      .get("/preferences", NotificationsRoutes.getPreferences)
      .put("/preferences", NotificationsRoutes.updatePreferences);
    this.router
      .get("/", NotificationsRoutes.get)
      .post("/", NotificationsRoutes.create);
    this.router
      .get("/:id", NotificationsRoutes.getOne)
      .put("/:id", NotificationsRoutes.update)
      .delete("/:id", NotificationsRoutes.delete);
    this.router.delete("/clear-all", NotificationsRoutes.clearAllNotifications);
  }
}
