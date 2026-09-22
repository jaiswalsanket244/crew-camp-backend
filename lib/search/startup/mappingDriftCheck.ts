import { SearchClientService } from "../searchClient";
import { emitSearchMetric } from "../emitMetric";
import { ADMIN_REQUEST_TIMEOUT_MS } from "../builders/timeouts";
import { PROJECTS_MAPPING_V1 } from "../mappings/projects-v1.mapping";
import { POSTS_UPLOADS_MAPPING_V1 } from "../mappings/posts-uploads-v1.mapping";

// Startup mapping drift check: the deployed OpenSearch mappings must match the source-of-truth TypeScript constants; a manual cluster edit that removes or retypes a field is "drift" and must be surfaced on every deploy. Runs from lib/index.ts on boot — non-fatal, drift/unreachability never crash the process. A 404-skip no-op until the concrete indexes exist.

export interface MappingRegistryEntry {
  // Alias to query (e.g. "projects", "posts_uploads") — never a versioned concrete index name; we compare against the alias target, not the index name.
  alias: string;
  // Expected mappings body (the { properties: {...} } object) from the typed constants.
  mapping: Record<string, unknown>;
}

// Source-of-truth registry. Each entry's `mapping` is the constant's `.mappings` sub-object (NOT the whole constant) so `mapping.properties` is populated and findMappingDrift actually compares fields.
export const MAPPING_REGISTRY: MappingRegistryEntry[] = [
  { alias: "projects", mapping: PROJECTS_MAPPING_V1.mappings },
  { alias: "posts_uploads", mapping: POSTS_UPLOADS_MAPPING_V1.mappings },
];

// Returns the field paths the constant declares but the deployed mapping is missing or has a different `type` for (empty list = no drift). Structural SUBSET check, NOT deep-equality: OpenSearch echoes back normalized mappings (defaults materialized, key order not guaranteed) so strict equality would report spurious drift; we only assert everything the constant requires is present and correctly typed, ignoring extra ES-added fields.
export const findMappingDrift = (
  expected: Record<string, unknown>,
  deployed: Record<string, unknown>,
  path = "",
): string[] => {
  const drift: string[] = [];
  const expProps = (expected?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const depProps = (deployed?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  for (const field of Object.keys(expProps)) {
    const here = path ? `${path}.${field}` : field;
    const exp = expProps[field];
    const dep = depProps[field];

    if (!dep) {
      drift.push(here); // field declared in constant but absent in deployed mapping
      continue;
    }
    // OpenSearch omits `type` for object fields in getMapping responses, so normalize: a field carrying `properties` is an object even when `type` is omitted (otherwise every object/nested field is false drift). This also catches scalar↔object retypes since the normalized types differ.
    const expType = exp.properties ? (exp.type ?? "object") : exp.type;
    const depType = dep.properties ? (dep.type ?? "object") : dep.type;
    if (expType !== depType) {
      drift.push(`${here} (type ${String(expType)} != ${String(depType)})`);
    }
    if (exp.properties) {
      drift.push(...findMappingDrift(exp, dep, here)); // recurse nested object fields
    }
  }

  return drift;
};

// Compares each registered mapping against its deployed counterpart and alerts on drift. Default arg = the real registry; tests pass a synthetic registry.
export const runMappingDriftCheck = async (
  registry: MappingRegistryEntry[] = MAPPING_REGISTRY,
): Promise<void> => {
  // Empty registry → no client, no network, sub-100ms, no logs.
  if (registry.length === 0) {
    return;
  }

  const client = SearchClientService.getInstance();

  for (const entry of registry) {
    try {
      // Boot-time op — use the longer ADMIN timeout, NOT the client's 1s default (which is for the user-facing read path); a cold cluster's first getMapping can take 2-5s (JVM GC + warmup) and a 1s ceiling caused `search.client.unreachable` on boot.
      const response = await client.indices.getMapping(
        { index: entry.alias },
        { requestTimeout: ADMIN_REQUEST_TIMEOUT_MS },
      );
      // getMapping returns { <concreteIndexName>: { mappings: {...} } }; an alias resolves to one concrete index, so take the first record's mappings body.
      const records = Object.values(response.body);
      const deployed = (records[0]?.mappings ?? {}) as Record<string, unknown>;

      const drift = findMappingDrift(entry.mapping, deployed);
      if (drift.length > 0) {
        // Error-level structured log (no shared logger for a request-less boot context; the codebase logs via console.*). The CloudWatch mapping_drift metric below is the real alert; no credentials/secrets in the payload.
        console.error("search.mapping_drift", {
          service: "search",
          tag: "search.mapping_drift",
          alias: entry.alias,
          drift,
        });
        // Increment the CloudWatch counter once per drifted mapping.
        emitSearchMetric("mapping_drift", 1, {});
      }
    } catch (error) {
      // Alias/index not created yet → skip, not drift. Duck-type the status: the OpenSearch ResponseError always exposes `.statusCode`, robust to transport wrapping.
      if ((error as { statusCode?: number })?.statusCode === 404) {
        continue;
      }
      // Connection/timeout/etc. → rethrow so lib/index.ts logs search.client.unreachable and continues (degraded). Never crash here.
      throw error;
    }
  }
};
