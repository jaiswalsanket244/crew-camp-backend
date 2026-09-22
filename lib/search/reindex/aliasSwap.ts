import { SearchClientService } from "../searchClient";

// Atomically points `alias` at `toIndex` (removing it from `fromIndex` if given) in a SINGLE _aliases request, so no reader window observes the alias on neither or both indices (zero-downtime cutover). NEVER deletes a concrete index — the old index is retained for rollback; cleanup is a separate operator action.
export const swapAlias = async (
  alias: string,
  fromIndex: string | null,
  toIndex: string,
): Promise<void> => {
  if (!alias || !toIndex) {
    throw new Error("swapAlias requires both `alias` and `toIndex`.");
  }

  // remove (when there is a prior index) BEFORE add — both applied atomically.
  const actions: Array<Record<string, unknown>> = [];
  if (fromIndex) {
    actions.push({ remove: { index: fromIndex, alias } });
  }
  actions.push({ add: { index: toIndex, alias } });

  const response =
    await SearchClientService.getInstance().indices.updateAliases({
      body: { actions },
    });

  // Don't report success for a swap the cluster didn't acknowledge within the
  // master timeout (consistent with deployMapping.ts).
  if (response.body && response.body.acknowledged === false) {
    throw new Error(
      `Alias swap for "${alias}" → "${toIndex}" was not acknowledged by the cluster.`,
    );
  }

  // Info-level structured log. No request-scoped Winston in a CLI/boot context — the search boot path logs via console.*.
  console.info("search.alias_swap", {
    service: "search",
    tag: "search.alias_swap",
    alias,
    from: fromIndex ?? null,
    to: toIndex,
  });
};
