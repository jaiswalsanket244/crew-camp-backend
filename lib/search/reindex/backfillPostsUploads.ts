import { Types } from "mongoose";
import { PostFiles, SearchBackfillState } from "../../db";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { BackfillResult } from "../../utils/interfaces/search";
import { SearchClientService } from "../searchClient";
import {
  PostFileRow,
  buildPostUploadSearchDoc,
  fetchActiveParentNotes,
  toStr,
} from "./postsUploadsSearchDoc";

const DEFAULT_TARGET_INDEX = "posts_uploads-v1";
// Modest default so a small node won't trip the request circuit breaker; tune via --batch-size.
const DEFAULT_BATCH_SIZE = 250;

// One page of PostFiles for a company, _id ASC, after the cursor.
const fetchPostFileBatch = async (
  companyId: ObjectIdType,
  afterId: ObjectIdType | null,
  batchSize: number,
): Promise<PostFileRow[]> => {
  const query: Record<string, unknown> = { companyId };
  if (afterId) {
    query._id = { $gt: afterId };
  }
  const rows: PostFileRow[] = await PostFiles.find(query)
    .sort({ _id: 1 })
    .limit(batchSize)
    .lean();
  return rows;
};

// Bulk-indexes one batch; returns the per-item failure count (bulk never rejects
// on per-doc errors — it resolves with body.errors).
const bulkIndexBatch = async (
  rows: PostFileRow[],
  noteMap: Map<string, string | null>,
  targetIndex: string,
): Promise<number> => {
  const client = SearchClientService.getInstance();
  const body: Record<string, unknown>[] = [];
  for (const file of rows) {
    const note = noteMap.get(toStr(file.postId)) ?? null;
    body.push({
      index: {
        _index: targetIndex,
        _id: toStr(file._id),
        routing: toStr(file.companyId), // must match query-time routing
      },
    });
    body.push(
      buildPostUploadSearchDoc(file, note) as unknown as Record<
        string,
        unknown
      >,
    );
  }

  let response;
  try {
    response = await client.bulk({ body }, { requestTimeout: 60000 });
  } catch (err) {
    // Request-level rejection (429/read-only/413): log the useful detail from ResponseError.meta, then abort — a rejected request is not success.
    const meta = (err as { meta?: { statusCode?: number; body?: unknown } })
      .meta;
    console.error("search.backfill.bulk_error", {
      service: "search",
      tag: "search.backfill.bulk_error",
      index: targetIndex,
      batchSize: rows.length,
      statusCode: meta?.statusCode,
      body: meta?.body,
    });
    throw err;
  }
  const resBody = response.body as {
    errors?: boolean;
    items?: Array<{ index?: { error?: unknown } }>;
  };

  let failures = 0;
  if (resBody.errors && Array.isArray(resBody.items)) {
    for (const item of resBody.items) {
      if (item.index && item.index.error) {
        failures += 1;
        console.error("search.backfill.item_error", {
          service: "search",
          tag: "search.backfill.item_error",
          index: targetIndex,
          error: item.index.error,
        });
      }
    }
  }
  return failures;
};

// Backfills the posts_uploads-v1 index from Mongo PostFiles (one doc per file),
// denormalizing the parent Posts.note. companyId scopes to one company; absent →
// every company, each resumable via the shared searchBackfillState checkpoint.
export const backfillPostsUploads = async (opts: {
  companyId?: ObjectIdType;
  batchSize?: number;
  targetIndex?: string;
}): Promise<BackfillResult> => {
  const targetIndex = opts.targetIndex ?? DEFAULT_TARGET_INDEX;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  // Coerce a provided companyId to ObjectId — find DOES auto-cast, but distinct
  // returns ObjectIds, so normalize for consistency.
  const companyIds: ObjectIdType[] = opts.companyId
    ? [new Types.ObjectId(String(opts.companyId))]
    : await PostFiles.distinct("companyId");

  const result: BackfillResult = {
    index: targetIndex,
    companiesProcessed: 0,
    companiesSkipped: 0,
    documentsIndexed: 0,
    failures: 0,
  };

  for (const companyId of companyIds) {
    if (!companyId) {
      result.companiesSkipped += 1;
      console.warn("search.backfill.skipped_company", {
        service: "search",
        tag: "search.backfill.skipped_company",
        index: targetIndex,
        reason: "missing companyId (cannot route)",
      });
      continue;
    }

    const checkpoint = await SearchBackfillState.findOne({
      companyId,
      index: targetIndex,
    });
    let afterId: ObjectIdType | null =
      (checkpoint && (checkpoint.lastProcessedFileId as ObjectIdType)) || null;
    let batchesCompleted = (checkpoint && checkpoint.batchesCompleted) || 0;

    if (!checkpoint) {
      await SearchBackfillState.create({
        companyId,
        index: targetIndex,
        batchesCompleted: 0,
        startedAt: new Date(),
      });
    }

    // Page PostFiles by _id ASC.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await fetchPostFileBatch(companyId, afterId, batchSize);
      if (rows.length === 0) {
        break;
      }

      const noteMap = await fetchActiveParentNotes(rows);
      const batchFailures = await bulkIndexBatch(rows, noteMap, targetIndex);
      result.failures += batchFailures;
      result.documentsIndexed += rows.length - batchFailures; // succeeded only

      afterId = rows[rows.length - 1]._id;
      batchesCompleted += 1;

      await SearchBackfillState.updateOne(
        { companyId, index: targetIndex },
        { $set: { lastProcessedFileId: afterId, batchesCompleted } },
      );
    }

    // Clear the checkpoint on completion so a re-run re-indexes while a crash mid-run resumes.
    await SearchBackfillState.deleteOne({ companyId, index: targetIndex });

    result.companiesProcessed += 1;
  }

  return result;
};

// The doc shape + parent-note logic now live in postsUploadsSearchDoc.ts (shared with the sync consumer for parity). Re-exported here to preserve the public surface tests + callers depend on.
export { buildPostUploadSearchDoc };
export type { PostFileRow, PostUploadSearchDoc } from "./postsUploadsSearchDoc";
export const __test__ = { buildPostUploadSearchDoc, DEFAULT_TARGET_INDEX };
