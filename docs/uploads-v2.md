# Uploads Feed V2 — `GET /api/posts/uploads/v2`

_Last updated: 2026-07-28 (branch `saketh/consoles`)._

A rebuilt read path for the grid uploads feed. Same request params and
response shape as `GET /api/posts/uploads`; the v1 endpoint and its code are
completely untouched, so the frontend can switch (or A/B) by changing only
the URL.

**Measured on staging** (M10, company with 1.55M active postfiles):

| Path | Latency |
|---|---|
| v1 grid pipeline | ~9.3s per cache miss (was up to 30s via HTTP) |
| v2, warm caches | **~150–185ms** |
| v2, cold caches (≤ once per user per 60s) | ~5.2s (non-admin) / ~1s (admin) |

---

## 1. Why v1 was slow

The grid feed sorts **files grouped by post**: newest post first (by the
post's "anchor date" = min `createdAt` across its files), files within a post
by `position`. v1 computed the anchor and per-post file rank **on every
request** over every matched file:

```
$match (all files of the company/project)   ← 1.5M docs
$setWindowFields partitionBy postId          ← blocking: materializes + groups everything
$sort anchor desc, postId desc, position asc ← blocking: sorts everything, spills to disk
$skip/$limit                                 ← keeps 20, discards the rest
```

Cost is O(all matched files) per request and grows with the collection. The
Redis payload cache hid this until any write invalidated it — which is why
the API was slowest right after creating a post.

## 2. The v2 design

Principle: **persist at write time what v1 computed at read time**, then let
an index serve the page.

1. **`PostFiles.postSortDate`** (new field) — the parent post's anchor date,
   stamped on every file at insert by schema hooks in `lib/db/postFiles.ts`:
   - files inserted with a new post → min `createdAt` of the batch (v1's math);
   - files added to an existing post → inherit the anchor from a sibling
     (one indexed `findOne`), so a post's files can never sort apart.
   - No insert call sites were modified; the hooks centralize it.
   - We could NOT just sort by `_id`/ObjectId time (which would have needed no
     migration): CompanyCam imports backdate `createdAt`
     (`lib/integrations/providers/companyCam/mapper.ts`), so insertion order
     ≠ display order for imported data.

2. **Compound indexes** that mirror the query exactly, e.g.
   `{ projectId, status, postSortDate: -1, postId: -1, position: 1, _id: 1 }`.
   The B-tree already stores entries in feed order, so a page is "walk the
   index, take 20". The page-id query projects only `{_id, postId}` → fully
   covered: `explain` shows `totalKeysExamined: 20, totalDocsExamined: 0`.
   - Four indexes (`uploads_v2_{project,company}_{newest,oldest}`): NEWEST and
     OLDEST each need their own direction because `position` stays ascending
     while the date keys flip — a reverse index walk can't serve the other
     sort. The `*_oldest` pair is droppable if that sort sees no traffic.
   - Indexes are deliberately **not** declared in the Mongoose schema:
     `autoIndex` is on by default and a deploy must never trigger a surprise
     index build on a billion-doc collection. They live only in the script
     (see §4).

3. **Bounded enrichment** — the 20 index entries are hydrated by running v1's
   own enrichment (window function for `fileIndex`, user/note lookups,
   display min-date) restricted to `postId ∈ page's posts`. Same math as v1 →
   exact display parity; cost bounded by page size, not collection size.

4. **Count cache** — `countDocuments` is the one remaining O(matched) cost
   (~0.9s company-wide, ~4.6s with a big `$in`; no index walk can fix
   "count everything"). `getCachedUploadsTotal`
   (`lib/services/redis/postCache.ts`) caches it for 60s in Redis under
   `posts-uploads:{companyId}:count:{sha1(matchQuery)}`, with an in-process
   fallback layer so it still works when Redis is unreachable (local dev).

5. **Delegations** — timestamp sorts (`DATE_TAKEN_*`) go to v1's
   `getGridPosts`, which already pages via a bounded find for that mode and
   sorts by a field that exists on every file (nothing to precompute); list
   mode (`isGridView` falsy) goes to the existing `findAllUploads`.

## 3. Files changed

| File | Change |
|---|---|
| `lib/db/postFiles.ts` | `postSortDate` field; pre-save / pre-insertMany hooks (anchor inheritance, min-of-batch fallback) |
| `lib/routes/posts/helper.ts` | `PostsHelper.getGridPostsV2`; 60s in-process memo for non-admin project scoping; sorted `$in` for stable cache keys |
| `lib/routes/posts/routes.ts` | `PostsRoutes.getUploadsV2` (validator, optional-auth like v1, date-bucketing reshape extracted for v2 use) |
| `lib/routes/posts/index.ts` | `GET /uploads/v2` registration |
| `lib/services/redis/postCache.ts` | `getCachedUploadsTotal` + `hashPostsCountQuery` + in-process fallback count cache |
| `scripts/backfillPostSortDate.js` | Backfill, orphan fill, index creation (see §4) |
| `docs/uploads-v2.md` | This doc |

## 4. Migration runbook (`scripts/backfillPostSortDate.js`)

Targets whatever `DB_PATH` is in `.env`. Compile first (`npm run tsc`).

```bash
node scripts/backfillPostSortDate.js                 # 1. backfill anchors (resumable)
node scripts/backfillPostSortDate.js --fill-orphans  # 2. files whose post was deleted
node scripts/backfillPostSortDate.js --create-indexes # 3. AFTER backfill, off-peak
```

- Backfill walks `posts` by `_id` asc, computes min file `createdAt` per post,
  bulk-updates only files still missing `postSortDate` → idempotent, and
  resumable with `--start-after-id <last logged checkpoint>`.
- Order matters: build indexes after the backfill so the build isn't churned
  by a billion updates.
- At production scale expect the backfill and each index build to take hours;
  run off-peak. The two `*_oldest` indexes are optional.

**Status:**
- ✅ **Staging** (`staging…/develop`) — done 2026-07-27: 95,603 posts /
  1,565,991 files backfilled in ~4 min; 2,467 orphans filled; 4 indexes built
  (~8s each).
- ✅ **Production** (`cluster0…/production`) — done 2026-07-28: backfill was
  already in place (2,410,898 of 2,411,359 files); the 461 stragglers were
  anchored (sibling-inherit, orphans → own createdAt); 4 indexes built
  (~10s each). Verified: busiest company (760k files) pages via
  `uploads_v2_company_newest`, 20 keys / 0 docs examined.
- ⚠️ **Deploy the new backend to production.** Until it ships, prod writes
  don't carry `postSortDate` (the schema hooks are in the new code) and the
  v2 endpoint doesn't exist there. After deploying, re-run the backfill once
  to anchor any files created in the gap.

## 5. Post-launch tuning (found while testing on staging)

Symptom: v2 still took 4–10s for user `672dad09978c51b5ce085180`
(`SUPERADMIN`, 1.5M-file company). Diagnosis:

- `SUPERADMIN` is not matched by `isAdminUser()` → the request takes the
  non-admin path (intentional per product decision: superadmins do not get
  company-wide feed access). That path cost:
  - `getMineAndCompanyProjects` → 9,609 project ids: ~1.4s **per request**;
  - `countDocuments` with a 9,609-id `$in`: ~4.6s **per request**;
  - (the indexed page walk itself was fine: ~70ms even with the `$in`).
- The count cache absorbed none of it because local `.env` has a placeholder
  `REDIS_URL` — Redis never connects and `cacheService` swallows errors
  silently.

Fixes: in-process fallback for the count cache; 60s in-process memo for the
project-scope lookup (empty scopes never memoized so an upstream error can't
blank a feed); `$in` list sorted so the count-cache hash is stable. Result:
cold ~5.2s at most once per user per minute, warm ~150–185ms.

Rejected during this work:
- Widening `isAdminUser` to include `SUPERADMIN` — product says superadmins
  don't access this data company-wide.
- Skipping the `$in` when a user belongs to every company project — **not**
  equivalent: the scope list excludes archived projects, so dropping it would
  leak archived-project files into the feed.

## 6. Caching & freshness semantics

| Cached thing | Where | TTL | Invalidation |
|---|---|---|---|
| Page contents | — (never cached in v2) | — | always live; new posts appear immediately |
| `total` count | Redis + per-instance memory | 60s | Redis layer wiped by `deletePattern` on writes for allowlisted companies; otherwise TTL only. In-process layer TTL only |
| Project scope (non-admin) | per-instance memory | 60s | TTL only; membership/archive changes heal ≤60s |

Net effect of creating a post: it appears in the feed on the next request;
only `total`/`totalPages` can lag ≤60s (invisible in a large grid).

## Grid project captions (CRE-143)

Grid items include top-level `projectId` and optional `projectName`, including
both `DATE_TAKEN_*` sorts. After date bucketing, these fields are at
`data[0].items[].posts[]`. Missing projects or blank names omit `projectName`
without dropping the photo. List-mode responses are unchanged.

Names are read with one company-scoped, deduplicated project query for the
returned page, after pagination and file ranking. Empty pages skip this query.
V2 reads current names on each request; no name cache, migration or new index
is required. The shared v1 grid helper also returns the fields, subject to
v1's existing payload-cache freshness.

Deploy this backend response before the web client that reads the caption
directly from the feed. The web client displays it only on the Home grid.

## 7. Known gaps / future work

- Project-scoped `DATE_TAKEN_*` sorts have no supporting index (pre-existing
  v1 gap). If metrics warrant: one index
  `{ projectId, status, timestamp: -1, createdAt: -1, _id: -1 }` serves both
  directions.
- Cold-request cost for heavy non-admin users is the `$in` count (~4.6s once
  per user per 60s). Options if it matters: raise the TTLs, or maintain
  running counters on write.
- Cross-instance count invalidation is TTL-only for the in-process layer; a
  Redis pub/sub broadcast could fix it but is overkill for an off-by-a-few
  total.
- `connectDB` logs the full connection string **including the password** on
  every boot — should be scrubbed before it lands in log aggregation.
- Compare `posts.uploads` vs `posts.uploads.v2` baseline-latency metrics
  after the frontend switches; v1 (and its payload cache + warmer) can be
  retired once parity is confirmed.
