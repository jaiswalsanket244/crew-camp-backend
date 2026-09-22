// Per-route OpenSearch request timeouts. `requestTimeout` is a TransportRequestOptions value passed as the 2nd arg to client.search(params, options) — NOT the body's `timeout` (a server-side partial-results Duration). Values sit above each route's p95 budget so healthy long-tail responses aren't cut off, and at/below the p99 ceiling so a timeout only trips under genuine degradation, letting the Mongo fallback fire fast.

// Global client-construction default — the ceiling for any call that does not pass its own requestTimeout; per-route values below override it on the read path.
export const GLOBAL_REQUEST_TIMEOUT_MS = 1000;

// Non-user-facing operations (boot-time drift check, admin/CLI work): no user is waiting, so tolerate the pilot cluster's 2-5s cold-start (JVM GC + warmup). Independent of GLOBAL_REQUEST_TIMEOUT_MS; callers MUST pass this explicitly as the 2nd-arg requestTimeout.
export const ADMIN_REQUEST_TIMEOUT_MS = 30000;

// GET /api/projects/list ES read path (route "projects.list", budget < 300ms p95).
export const PROJECTS_LIST_REQUEST_TIMEOUT_MS = 500;

// GET /api/posts/uploads ES read path (route "posts.uploads", budget < 400ms p95).
export const POSTS_UPLOADS_REQUEST_TIMEOUT_MS = 800;
