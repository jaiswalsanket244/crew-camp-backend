import "./utils/bamlLogging";
import * as express from "express";
import * as http from "http";
import * as compression from "compression";
import * as cors from "cors";
import { api } from "./routes/api";
import { config } from "./utils/configuration/config";
import { WebhookRouter } from "./routes/webhooks";
import { ExternalApi } from "./routes/external/v1";
import path = require("path");
import { blockExternalApiRequests } from "./middleware/externalApi";
import { requestRateLimiter } from "./middleware/rateLimit";
import { connectDB } from "./services/connectDB";
import { WEB_APP_ORIGINS } from "./utils/constants/constants";
import { connectRedis } from "./services/redis";
import "./services/redis/cacheWarmerSetup";
import { runMappingDriftCheck } from "./search/startup/mappingDriftCheck";

const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    // Connect to Redis (non-blocking - server starts even if Redis fails)
    connectRedis();

    // Mapping drift check. Non-fatal: a drifted or unreachable search cluster must never block API boot; no-op today (empty MAPPING_REGISTRY). Own try/catch — the outer catch exits the process.
    try {
      await runMappingDriftCheck();
    } catch (error) {
      console.error("search.client.unreachable", {
        service: "search",
        tag: "search.client.unreachable",
        message: (error as Error)?.message,
      });
    }

    const app = express();
    // Behind a load balancer: trust exactly 1 proxy hop so req.ip resolves to
    // the real client IP from X-Forwarded-For (instead of the LB's IP).
    // Increase this count if additional proxies (e.g. a CDN) sit in front.
    app.set("trust proxy", 1);
    app.use(
      "/.well-known/apple-app-site-association",
      express.static("./apple-app-site-association"),
    );
    app.use(
      "/.well-known/assetlinks.json",
      express.static("./assetlinks.json"),
    );

    // Configure CORS properly for all allowed origins
    app.use(
      cors({
        origin: WEB_APP_ORIGINS,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
        allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
        credentials: true,
        preflightContinue: false,
        optionsSuccessStatus: 204,
      }),
    );

    app.use(express.urlencoded({ extended: true }));
    app.use(
      express.json({
        limit: "1mb", // Supports large gallery shares (up to ~5000 files)
        // Preserve the raw request body so Stripe webhook signatures can be
        // verified against the exact bytes Stripe signed. Non-invasive: req.body
        // is still the parsed object for every other route.
        verify: (req: express.Request, _res, buf) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use(compression()); // for gzipping

    app.use("/v1", requestRateLimiter, ExternalApi);

    // Middleware to block requests to /api from api.crewcamapp.com

    app.use("/webhook", new WebhookRouter().router); // Using the stripe webhook here to bypass express.json().
    app.use("/api", blockExternalApiRequests, api);

    const reactAppBuildPath = path.join(__dirname, "../build");
    app.use(express.static(reactAppBuildPath));

    // JSON error handler — must be registered before the catchall
    app.use(
      (
        err: any,
        req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        next: express.NextFunction,
      ) => {
        console.error("Unhandled error:", err);
        const status = err.status ?? err.statusCode ?? 500;
        res
          .status(status)
          .json({ message: err.message ?? "Internal server error" });
      },
    );

    // The "catchall" handler: for any request that doesn't match one above, send back React's index.html file.
    app.get("*", (req, res) => {
      res.sendFile(path.join(reactAppBuildPath, "index.html"));
    });

    const port = config.PORT || "8000";
    app.set("port", port);

    const server = http.createServer(app);

    server.listen(port, () => console.info(`API running on localhost:${port}`));
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
};

startServer();
