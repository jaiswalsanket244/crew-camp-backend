import * as express from "express";
import { emitSearchMetric } from "./emitMetric";
import { config } from "../utils/configuration/config";

// Records Mongo-handler request latency as the mongo_baseline_latency metric for the ES-vs-Mongo baseline comparison; gated behind ENABLE_BASELINE_METRICS and never throws into the request path.
export const instrumentBaselineLatency = (
  res: express.Response,
  route: string,
  getCompanyId: () => string | undefined,
): void => {
  // Tolerant toggle parse: only an explicit "true" (any casing/whitespace) enables it; default is off.
  if ((config.ENABLE_BASELINE_METRICS ?? "").trim().toLowerCase() !== "true") {
    return;
  }
  const start = Date.now();
  // `once` prevents a duplicate emit if a wrapper ever re-emits the response.
  res.once("finish", () => {
    try {
      // Baseline = successful Mongo query latency; exclude error responses so they don't distort p50/p99.
      if (res.statusCode >= 400) {
        return;
      }
      const companyId = getCompanyId();
      if (!companyId) {
        return; // anonymous / unattributable request — record no baseline
      }
      // Wall-clock can step backward (NTP) yielding a negative delta; emitSearchMetric only drops non-finite values, so guard negatives here.
      const durationMs = Date.now() - start;
      if (durationMs < 0) {
        return;
      }
      emitSearchMetric("mongo_baseline_latency", durationMs, {
        route,
        companyId,
      });
    } catch {
      // A metrics failure must never affect the request.
    }
  });
};
