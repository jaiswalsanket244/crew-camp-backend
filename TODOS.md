# TODOS

## Orphaned postFiles after post deletion
**What:** `deletePost` (lib/routes/posts/helper.ts) only sets `Posts.status=DELETED`; it does not cascade to the `postfiles` collection, so deleted posts leave PostFiles rows behind.
**Why:** Latent storage bloat / data drift. Any query counting postfiles directly by projectId overcounts (the uploads grid and the new photo badge both already count ACTIVE postfiles, so they match each other, but the orphans persist).
**Context:** Surfaced during /plan-eng-review of project tab-count badges (2026-06-05). Per-file deletes hard-delete postfiles; only whole-post deletion leaks.
**Where to start:** Cascade in `deletePost` or a cron purging postfiles whose parent post is DELETED.

## totalFiles reconciliation job
**What:** `posts.totalFiles` is a denormalized counter mutated across create/add/remove/restore/move.
**Why:** Denormalized counters drift; a durable reconciliation/repair beats one-time checks.
**Context:** Surfaced during /plan-eng-review (2026-06-05), raised by the Codex outside-voice pass. The photo badge now counts postfiles directly (not totalFiles), so this is lower priority, but totalFiles is still read for upload pagination.
**Where to start:** A periodic job recomputing totalFiles from active postfiles; alert on drift.
