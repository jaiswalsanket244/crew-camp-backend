import { ObjectIdType } from "../utils/interfaces/schemaInterface";
import { SearchFlag, SearchRouteDefault } from "../db";

// Per-company × per-route ES read-path flag check with a 30s in-process per-pod cache (warm hit is a pure Map lookup; a flag flip propagates within the TTL without a restart). Fail-closed — absent flag/default means disabled (serves Mongo). Precedence: (a) per-company SearchFlag override, (b) else route-level SearchRouteDefault, (c) else false.
const TTL_MS = 30000;
const cache = new Map<string, { enabled: boolean; cachedAt: number }>();

export const isSearchEnabled = async (
  companyId: ObjectIdType,
  route: string,
): Promise<boolean> => {
  const key = `${companyId}:${route}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAt < TTL_MS) {
    return hit.enabled;
  }

  // `.lean()` does not apply schema defaults, so `=== true` guarantees a real boolean (fail closed).
  const flag = await SearchFlag.findOne({ companyId, route }).lean();
  let enabled: boolean;
  if (flag) {
    enabled = flag.enabled === true; // per-company override wins (incl. force-OFF)
  } else {
    const def = await SearchRouteDefault.findOne({ route }).lean();
    enabled = def?.enabled === true; // route default, else fail closed
  }

  cache.set(key, { enabled, cachedAt: Date.now() });
  return enabled;
};
