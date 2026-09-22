import { SearchClientService } from "../searchClient";

// Debug helper: fetch the ES `_source` for a Mongo `_id` so an engineer can compare ES vs Mongo when chasing parity/drift (null if missing). ROUTING: projects / posts_uploads are routed by companyId, so a get WITHOUT routing reads the wrong shard and 404s a doc that exists — pass `routing` (the companyId) to inspect docs in those indexes.
export const inspectDocument = async (
  index: string,
  id: string,
  routing?: string,
): Promise<object | null> => {
  try {
    const response = await SearchClientService.getInstance().get({
      index,
      id,
      ...(routing ? { routing } : {}),
    });
    return (response.body?._source as object) ?? null;
  } catch (error) {
    // Missing document → OpenSearch 404 (duck-typed, same as mappingDriftCheck).
    if ((error as { statusCode?: number })?.statusCode === 404) {
      return null;
    }
    throw error;
  }
};
