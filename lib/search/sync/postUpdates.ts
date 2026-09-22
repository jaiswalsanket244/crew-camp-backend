import { emitIndexingLag } from "../emitMetric";
import { SearchClientService } from "../searchClient";
import {
  PostFileRow,
  buildPostUploadSearchDoc,
  fetchActiveParentNote,
  toStr,
} from "../reindex/postsUploadsSearchDoc";
import { MongoChangeEvent } from "./projectUpdates";

const POSTS_UPLOADS_ALIAS = "posts_uploads";

// Applies one PostFiles change-stream event to the `posts_uploads` ES alias. The index models PostFiles (one ES doc per file), so the consumer tails the `postFiles` collection (NOT `Posts`). insert/update/replace → build the doc from the event's post-image with the SAME shared mapper as the backfill (parity) and upsert via `index` (deterministic _id = idempotent). A soft-delete (status → DELETED) arrives as an `update` and is RE-INDEXED, not removed: the index stores all statuses; the read path filters ACTIVE. A hard delete → remove by _id with deleteByQuery (routing-agnostic: a delete event carries no companyId, so a routed `delete` would hit the wrong shard and silently miss).
export const applyPostsUploadsChange = async (
  event: MongoChangeEvent,
): Promise<void> => {
  const docId = event.documentKey?._id;
  if (!docId) {
    return; // defensive — no document key, nothing to apply
  }
  const idStr = toStr(docId);
  const client = SearchClientService.getInstance();

  if (event.operationType === "delete") {
    await client.deleteByQuery({
      index: POSTS_UPLOADS_ALIAS,
      body: { query: { ids: { values: [idStr] } } },
    });
    return;
  }

  if (
    event.operationType === "insert" ||
    event.operationType === "update" ||
    event.operationType === "replace"
  ) {
    const file = event.fullDocument as unknown as PostFileRow | null;
    if (!file) {
      return; // file deleted between the event and the lookup — skip
    }
    const companyId = toStr(file.companyId);
    if (!companyId) {
      // companyId is schema-required; defensively skip un-routable files.
      console.warn("search.indexing.skipped", {
        service: "search",
        tag: "search.indexing.skipped",
        index: POSTS_UPLOADS_ALIAS,
        documentId: idStr,
        reason: "missing companyId (cannot route)",
      });
      return;
    }

    const note = await fetchActiveParentNote(file.postId);
    const doc = buildPostUploadSearchDoc(file, note);
    await client.index({
      index: POSTS_UPLOADS_ALIAS,
      id: idStr,
      routing: companyId,
      body: doc as unknown as Record<string, unknown>,
    });
    // Lag from the PostFiles write (the indexed entity's own updatedAt).
    emitIndexingLag(POSTS_UPLOADS_ALIAS, file.updatedAt);
    return;
  }

  // Other operationTypes (drop, dropDatabase, rename, invalidate) → ignore.
};
