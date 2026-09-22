import { SearchClientService } from "../searchClient";
import { IndexMapping } from "../types";
import { PROJECTS_MAPPING_V1 } from "../mappings/projects-v1.mapping";
import { POSTS_UPLOADS_MAPPING_V1 } from "../mappings/posts-uploads-v1.mapping";

// Maps a concrete index name → its source-of-truth mapping constant. The KEY is the deployed index name (and the CLI --mapping arg), so `posts_uploads` uses an underscore to match its alias (NOT the hyphenated source filename). Typed as IndexMapping so every value is compile-time checked and the valid set lives in one place, extensible with -v2 entries.
const DEPLOYABLE_MAPPINGS: Record<string, IndexMapping> = {
  "projects-v1": PROJECTS_MAPPING_V1,
  "posts_uploads-v1": POSTS_UPLOADS_MAPPING_V1,
};

// Resolve a concrete versioned index name to its alias's source-of-truth mapping. Exact match first (back-compat with the v1 deploy CLI), else match by alias prefix (strip the -vN suffix) so reindex can deploy a fresh version (projects-v2, projects-v3, …) from the same alias mapping.
const resolveMapping = (mappingName: string): IndexMapping | undefined => {
  if (DEPLOYABLE_MAPPINGS[mappingName]) {
    return DEPLOYABLE_MAPPINGS[mappingName];
  }
  const alias = mappingName.replace(/-v\d+$/, "");
  for (const [key, mapping] of Object.entries(DEPLOYABLE_MAPPINGS)) {
    if (key.replace(/-v\d+$/, "") === alias) {
      return mapping;
    }
  }
  return undefined;
};

// Creates a new versioned concrete index in the cluster from its TypeScript mapping constant (mappings deploy from code, never by hand). Does NOT create or move an alias and does NOT replace an existing index (use --reindex). IndexMapping === the indices.create body, so the constant passes straight through as `body`.
export const deployMapping = async (mappingName: string): Promise<void> => {
  const mapping = resolveMapping(mappingName);
  if (!mapping) {
    throw new Error(
      `Unknown mapping "${mappingName}". Valid: ${Object.keys(
        DEPLOYABLE_MAPPINGS,
      ).join(", ")}`,
    );
  }

  const client = SearchClientService.getInstance();

  try {
    // 30s per-request timeout overrides the 1s client default: creating a 3-shard/1-replica index on the t3.small pilot node can exceed 1s.
    const response = await client.indices.create(
      { index: mappingName, body: mapping },
      { requestTimeout: 30000 },
    );

    // Don't report success for a not-actually-created index: acknowledged=false means the request wasn't accepted in time (failure); shards_acknowledged=false means the index exists but its shards didn't all start within the timeout (usable, but warn).
    const body = response.body;
    if (body.acknowledged === false) {
      throw new Error(
        `Index ${mappingName} create was not acknowledged by the cluster (acknowledged=false). Re-check cluster state before retrying.`,
      );
    }
    if (body.shards_acknowledged === false) {
      console.warn(
        `⚠️  Index ${mappingName} created, but not all shards acknowledged within the timeout (shards_acknowledged=false) — it may still be initializing.`,
      );
    }
    console.log(`✅ Created index ${mappingName}`);
  } catch (error) {
    // Idempotent re-run: index already exists. Duck-type the OpenSearch error (statusCode 400 + body.error.type); instanceof is brittle under transport wrapping.
    const type = (error as { body?: { error?: { type?: string } } })?.body
      ?.error?.type;
    if (type === "resource_already_exists_exception") {
      throw new Error(
        `Index ${mappingName} already exists. To replace, use the --reindex flag.`,
      );
    }
    throw error;
  }
};
