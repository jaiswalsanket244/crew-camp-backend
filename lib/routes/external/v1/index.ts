import * as express from "express";
import { ApiKeyMiddleware } from "../../../middleware/apiKeyAuth";
import {
  externalApiRateLimiter,
  externalApiWriteRateLimiter,
} from "../../../middleware/rateLimit";
import { ProjectRouter } from "./Projects";
import { TagsRouter } from "./tags";
import { PostRouter } from "./posts";
import { CheckListRouter } from "./checklists";
import { ProjectNotesRouter } from "./projectNotes";
import { UploadRouter } from "./uploads";

const middleware = new ApiKeyMiddleware();

export const ExternalApi = express.Router();
ExternalApi.use(middleware.auth);
// Per-key budgets, mounted after auth so req.apiKey is populated. The per-IP
// limiter in lib/index.ts still fronts the auth path itself.
ExternalApi.use(externalApiRateLimiter);
ExternalApi.use(externalApiWriteRateLimiter);
ExternalApi.use("/projects", new ProjectRouter().router);
ExternalApi.use("/posts", new PostRouter().router);
ExternalApi.use("/checklist", new CheckListRouter().router);
ExternalApi.use("/tags", new TagsRouter().router);
ExternalApi.use("/projectNotes", new ProjectNotesRouter().router);
ExternalApi.use("/uploads", new UploadRouter().router);

ExternalApi.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "External API v1 is running",
    timestamp: new Date().toISOString(),
  });
});
