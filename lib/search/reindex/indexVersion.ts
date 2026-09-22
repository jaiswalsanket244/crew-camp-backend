import { SearchClientService } from "../searchClient";

// Resolve the concrete versioned index a search alias currently points to (e.g. "projects" -> "projects-v1"). Returns null when the alias does not exist yet (first-ever reindex), so the caller starts at -v1.
export const getCurrentIndex = async (
  alias: string,
): Promise<string | null> => {
  const client = SearchClientService.getInstance();
  try {
    const response = await client.indices.getAlias({ name: alias });
    // getAlias({name}) returns { "<concrete-index>": { aliases: { <alias>: {} } } }.
    // Blue-green swaps are atomic, so an alias normally maps to exactly one index.
    const indices = Object.keys(response.body || {});
    return indices.length > 0 ? indices[0] : null;
  } catch (error) {
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;
    const type = (error as { body?: { error?: { type?: string } } })?.body
      ?.error?.type;
    if (statusCode === 404 || type === "alias_not_found_exception") {
      return null;
    }
    throw error;
  }
};

// Compute the next versioned concrete index for an alias: "projects-v1" -> "projects-v2";
// null/absent -> "<alias>-v1". Throws if `current` exists but has no parseable -vN suffix.
export const nextVersion = (current: string | null, alias: string): string => {
  if (!current) {
    return `${alias}-v1`;
  }
  const match = current.match(/-v(\d+)$/);
  if (!match) {
    throw new Error(
      `Cannot parse a -vN version from current index "${current}" (alias "${alias}").`,
    );
  }
  return `${alias}-v${Number(match[1]) + 1}`;
};
