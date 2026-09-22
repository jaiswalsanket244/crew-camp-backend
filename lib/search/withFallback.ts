import { ObjectIdType } from "../utils/interfaces/schemaInterface";
import { emitSearchMetric } from "./emitMetric";
import { isSearchEnabled } from "./flags";

// The root-cause class of an ES read failure — attached to the search.fallback log and the mongo_fallback metric `reason` dimension. The per-route timeout that produces "timeout" is configured elsewhere; here we only classify it.
export type SearchErrorReason =
  | "timeout"
  | "5xx"
  | "parse_error"
  | "network"
  | "other";

// Maps an ES failure to its root-cause class by switching on `err.name` rather than `instanceof` (ES5 target + multiple module copies make `instanceof` unreliable) and keeps the helper free of any opensearch import. esCall thunks throw a plain Error("Malformed OpenSearch response...") for a bad payload → parse_error, matched first.
export const classifySearchError = (err: unknown): SearchErrorReason => {
  const name = (err as { name?: string } | null)?.name;
  const message = (err as { message?: string } | null)?.message;
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;

  if (message && message.startsWith("Malformed OpenSearch response")) {
    return "parse_error";
  }
  switch (name) {
    case "TimeoutError":
    case "RequestAbortedError":
      return "timeout";
    case "ConnectionError":
    case "NoLivingConnectionsError":
      return "network";
    case "DeserializationError":
    case "SerializationError":
      return "parse_error";
    case "ResponseError":
      return statusCode != null && statusCode >= 500 ? "5xx" : "other";
    default:
      return "other";
  }
};

// The dual-path orchestration seam every migrated handler calls; gates ES-vs-Mongo on the per-company × per-route flag. `esCall`/`mongoCall` are lazy thunks so the ES path is never invoked when the flag is off. Imports from the LEAF modules (not the barrel) so the call site resolves to the same module object a test stubs.
export const searchWithFallback = async <T>(
  route: string,
  companyId: ObjectIdType,
  esCall: () => Promise<T>,
  mongoCall: () => Promise<T>,
  opts?: { forcePath?: "es" | "mongo" },
): Promise<T> => {
  // Parity harness: force a path, bypassing the flag + metrics, so runParity can diff ES vs Mongo for the same request and time each independently. NEVER set on a production request.
  if (opts?.forcePath === "es") {
    return esCall();
  }
  if (opts?.forcePath === "mongo") {
    return mongoCall();
  }
  if (!(await isSearchEnabled(companyId, route))) {
    emitSearchMetric("mongo_only", 1, {
      route,
      companyId: companyId.toString(),
    });
    return mongoCall();
  }
  // Flag on: time and try ES, and on ANY failure transparently fall back to Mongo — the user never sees an ES error, just the slower Mongo result. `await esCall()` (not a bare return) so a rejected ES promise is caught here. Emit query_latency on success, query_errors on failure; mongo_fallback + one warn log per fallback are emitted BEFORE mongoCall() resolves so dashboards reflect the failure even if Mongo also fails.
  const start = Date.now();
  try {
    const result = await esCall();
    // Clamp for wall-clock skew (a backward step would emit a negative sample) — mirrors emitIndexingLag's Math.max(0, …).
    emitSearchMetric("query_latency", Math.max(0, Date.now() - start), {
      route,
      companyId: companyId.toString(),
    });
    return result;
  } catch (err) {
    const reason = classifySearchError(err);
    emitSearchMetric("mongo_fallback", 1, {
      route,
      companyId: companyId.toString(),
      reason,
    });
    emitSearchMetric("query_errors", 1, {
      route,
      companyId: companyId.toString(),
      reason,
    });
    console.warn("search.fallback", {
      service: "search",
      tag: "search.fallback",
      route,
      companyId: companyId.toString(),
      reason,
    });
    return mongoCall();
  }
};
