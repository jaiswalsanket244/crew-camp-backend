import { SearchClientService } from "./searchClient";
import { emitSearchMetric } from "./emitMetric";

// OpenSearch cluster health → the `cluster_status` gauge value (0/1/2).
const STATUS_TO_GAUGE: Record<string, number> = { green: 0, yellow: 1, red: 2 };

// Publishes cluster health as the `cluster_status` CloudWatch gauge (green/yellow/red → 0/1/2) on a 1-minute cron. Fire-and-forget: a health-check or metric failure must NEVER crash the cron — log a structured warn and move on.
export const emitClusterStatus = async (): Promise<void> => {
  try {
    const result = await SearchClientService.getInstance().cluster.health();
    const status = (result?.body?.status ?? "").toString().toLowerCase();
    const gauge = STATUS_TO_GAUGE[status];
    if (gauge === undefined) {
      console.warn("search.cluster_status_unknown", {
        service: "search",
        tag: "search.cluster_status_unknown",
        status,
      });
      return;
    }
    emitSearchMetric("cluster_status", gauge, {});
  } catch (error) {
    console.warn("search.cluster_status_failed", {
      service: "search",
      tag: "search.cluster_status_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
