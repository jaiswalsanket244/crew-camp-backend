import { SearchClientService } from "../../../search";
import { SearchClusterStatusType } from "../../../utils/interfaces/search";
import { SearchFlag, SearchJob, SearchRouteDefault } from "../../../db";

export class AdminSearchHelpers {
  // Enqueue a reindex job: inserts a PENDING SearchJob the search-worker polls + claims. status defaults to PENDING and progress to {0,0} (model defaults); companyId/since are set only when provided (REINDEX_FULL has neither).
  public static enqueueReindexJob = async ({
    type,
    index,
    companyId,
    since,
    triggeredBy,
  }: {
    type: string;
    index: string;
    companyId?: string;
    since?: string;
    triggeredBy: unknown;
  }) => {
    const doc: Record<string, unknown> = { type, index, triggeredBy };
    if (companyId) doc.companyId = companyId;
    if (since) doc.since = since;
    return SearchJob.create(doc);
  };

  // Upsert the per-company × per-route ES feature flag: the (companyId, route) filter + upsert means an insert derives both key fields from the filter, so the SearchFlag unique index is respected and no null-keyed row is possible. The isSearchEnabled cache picks up the change within its 30s TTL.
  public static upsertFlag = async (
    companyId: string,
    route: string,
    enabled: boolean,
    updatedBy: unknown,
  ) => {
    return SearchFlag.findOneAndUpdate(
      { companyId, route },
      { $set: { enabled, updatedBy } },
      { upsert: true, new: true },
    );
  };

  // Upsert the route-level default flag: one row per route; the {route} filter + upsert means an insert derives the key from the filter (no null-key row). isSearchEnabled falls back to this for any company without a per-company SearchFlag row.
  public static upsertRouteDefault = async (
    route: string,
    enabled: boolean,
    updatedBy: unknown,
  ) => {
    return SearchRouteDefault.findOneAndUpdate(
      { route },
      { $set: { enabled, updatedBy } },
      { upsert: true, new: true },
    );
  };

  // Live cluster health + placeholders (indices / lag / fallback / flags) filled in later. The search client is reached via the lib/search barrel — this module never imports the @opensearch-project/opensearch package directly (module boundary).
  public static getClusterHealth = async (): Promise<{
    cluster: SearchClusterStatusType;
  }> => {
    const client = SearchClientService.getInstance();
    const result = await client.cluster.health();
    const body = result.body;

    // A 200 from cluster.health() can still carry a non-conformant body (a proxy/WAF envelope, a partial/degraded response); validate the live fields before mapping so a malformed body surfaces as an error to next(error) — never a 200 with undefined fields, and never swallowed into a fabricated "red" status.
    if (
      !body ||
      typeof body.status !== "string" ||
      typeof body.number_of_nodes !== "number" ||
      typeof body.number_of_pending_tasks !== "number"
    ) {
      throw new Error(
        "Unexpected OpenSearch cluster.health() response shape: missing status/node-count/pending-tasks.",
      );
    }

    return {
      cluster: {
        // OpenSearch's HealthStatus allows upper/lower-case variants; normalize to the lowercase union the API contract exposes.
        status: body.status.toLowerCase() as SearchClusterStatusType["status"],
        nodeCount: body.number_of_nodes,
        pendingTasks: body.number_of_pending_tasks,
        indices: [],
        indexingLagP99Ms: null,
        fallbackRatePerRoute: {},
        flagsByCompany: {},
      },
    };
  };
}
