import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { config } from "../utils/configuration/config";

// Shared CloudWatch metric emitter for the search platform; all search code emits through this — never call CloudWatch directly.
class SearchMetricService {
  private static client: CloudWatchClient;

  private static readonly NAMESPACE = "CrewCam/Search";

  // Metric taxonomy: metric name -> dimensions that MUST be present.
  private static readonly REQUIRED_DIMENSIONS: Record<string, string[]> = {
    query_latency: ["route", "companyId"],
    query_errors: ["route", "companyId"],
    mongo_fallback: ["route", "companyId"],
    mongo_only: ["route", "companyId"],
    mongo_baseline_latency: ["route", "companyId"],
    indexing_lag: ["index"],
    indexing_applied: ["index", "event_type"],
    indexing_errors: ["index", "event_type"],
    cluster_status: [],
    reindex_progress: ["jobId", "index"],
    mapping_drift: [],
  };

  private static getClient = (): CloudWatchClient => {
    if (!SearchMetricService.client) {
      SearchMetricService.client = new CloudWatchClient({
        region: config.S3_BUCKET_REGION,
        credentials: {
          accessKeyId: config.S3_USER_KEY,
          secretAccessKey: config.S3_USER_SECRET,
        },
      });
    }
    return SearchMetricService.client;
  };

  public static emit = (
    name: string,
    value: number,
    dimensions: Record<string, string>,
  ): void => {
    const required = SearchMetricService.REQUIRED_DIMENSIONS[name];
    if (!required) {
      throw new Error(`Unknown search metric: ${name}`);
    }
    const missing = required.filter((dim) => !dimensions[dim]);
    if (missing.length > 0) {
      throw new Error(
        `Metric ${name} missing required dimensions: ${missing.join(", ")}`,
      );
    }

    // Drop non-finite values (e.g. NaN) — CloudWatch rejects them and the fire-and-forget catch would swallow it; do not throw, a metric glitch must never break the request.
    if (!Number.isFinite(value)) {
      console.error("emitSearchMetric: non-finite value dropped", name, value);
      return;
    }

    // Keep unit tests hermetic — no network call under NODE_ENV=test.
    if (config.NODE_ENV === "test") {
      return;
    }

    const command = new PutMetricDataCommand({
      Namespace: SearchMetricService.NAMESPACE,
      MetricData: [
        {
          MetricName: name,
          Value: value,
          Dimensions: Object.entries(dimensions).map(([dimName, dimValue]) => ({
            Name: dimName,
            Value: dimValue,
          })),
        },
      ],
    });

    // Fire-and-forget — a metrics failure must never break a request.
    SearchMetricService.getClient()
      .send(command)
      .catch((error) => console.error("emitSearchMetric failed", name, error));
  };
}

export const emitSearchMetric = SearchMetricService.emit;

// Emit per-index indexing lag at ES-commit time: lag = now - the source Mongo write's updatedAt (the changed entity's, not the unchanged project's). No-ops on a missing or non-finite timestamp so a bogus lag is never sent.
export const emitIndexingLag = (
  index: string,
  mongoUpdatedAt?: Date | string | number | null,
): void => {
  if (mongoUpdatedAt == null) {
    return;
  }
  const t =
    mongoUpdatedAt instanceof Date
      ? mongoUpdatedAt.getTime()
      : new Date(mongoUpdatedAt).getTime();
  if (!Number.isFinite(t)) {
    return;
  }
  // Clamp at 0: clock skew (worker host behind the Mongo primary) can make the delta negative, which would corrupt CloudWatch percentiles.
  emitSearchMetric("indexing_lag", Math.max(0, Date.now() - t), { index });
};
