import { PipelineStage, Types } from "mongoose";
import { Project, SearchBackfillState } from "../../db";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { BackfillResult } from "../../utils/interfaces/search";
import { SearchClientService } from "../searchClient";
import {
  PROJECT_DOC_PIPELINE_STAGES,
  ProjectAggRow,
  buildProjectSearchDoc,
  toStr,
} from "./projectSearchDoc";

const DEFAULT_TARGET_INDEX = "projects-v1";
// Modest default so a small node won't trip the request circuit breaker; tune via --batch-size.
const DEFAULT_BATCH_SIZE = 250;

// Runs the parity aggregation for one company, one page (projects with _id > afterId, sorted _id ASC, limited to batchSize), composing the SHARED doc pipeline after the paging prefix so backfill and sync produce identical docs.
const aggregateProjectBatch = async (
  companyId: ObjectIdType,
  afterId: ObjectIdType | null,
  batchSize: number,
): Promise<ProjectAggRow[]> => {
  const match: Record<string, unknown> = { companyId };
  if (afterId) {
    match._id = { $gt: afterId };
  }

  const pipeline: PipelineStage[] = [
    { $match: match },
    { $sort: { _id: 1 } },
    { $limit: batchSize },
    ...PROJECT_DOC_PIPELINE_STAGES,
  ];

  const rows: ProjectAggRow[] = await Project.aggregate(pipeline);
  return rows;
};

// Bulk-indexes one batch of docs; returns the per-item failure count. Bulk never
// rejects on per-document errors — it resolves with body.errors — so we inspect
// the response and surface failures rather than silently dropping them.
const bulkIndexBatch = async (
  rows: ProjectAggRow[],
  targetIndex: string,
): Promise<number> => {
  const client = SearchClientService.getInstance();
  const body: Record<string, unknown>[] = [];
  for (const row of rows) {
    body.push({
      index: {
        _index: targetIndex,
        _id: toStr(row._id),
        routing: toStr(row.companyId), // must match query-time routing
      },
    });
    body.push(buildProjectSearchDoc(row) as unknown as Record<string, unknown>);
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

// Backfills the projects-v1 index from Mongo. companyId scopes to one company;
// absent → every company (distinct Projects.companyId), each resumable via the
// searchBackfillState checkpoint.
export const backfillProjects = async (opts: {
  companyId?: ObjectIdType;
  batchSize?: number;
  targetIndex?: string;
}): Promise<BackfillResult> => {
  const targetIndex = opts.targetIndex ?? DEFAULT_TARGET_INDEX;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  // Coerce a provided companyId to ObjectId — aggregation $match does NOT
  // auto-cast strings (unlike find), so a CLI-passed string would never match.
  const companyIds: ObjectIdType[] = opts.companyId
    ? [new Types.ObjectId(String(opts.companyId))]
    : await Project.distinct("companyId");

  const result: BackfillResult = {
    index: targetIndex,
    companiesProcessed: 0,
    companiesSkipped: 0,
    documentsIndexed: 0,
    failures: 0,
  };

  for (const companyId of companyIds) {
    if (!companyId) {
      // Unroutable (no companyId) — skip, but surface it (don't drop silently).
      result.companiesSkipped += 1;
      console.warn("search.backfill.skipped_company", {
        service: "search",
        tag: "search.backfill.skipped_company",
        index: targetIndex,
        reason: "missing companyId (cannot route)",
      });
      continue;
    }

    // Resume from the checkpoint if one exists for (companyId, index).
    const checkpoint = await SearchBackfillState.findOne({
      companyId,
      index: targetIndex,
    });
    let afterId: ObjectIdType | null =
      (checkpoint && (checkpoint.lastProcessedProjectId as ObjectIdType)) ||
      null;
    let batchesCompleted = (checkpoint && checkpoint.batchesCompleted) || 0;

    if (!checkpoint) {
      await SearchBackfillState.create({
        companyId,
        index: targetIndex,
        batchesCompleted: 0,
        startedAt: new Date(),
      });
    }

    // Page through this company's projects by _id ASC.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await aggregateProjectBatch(companyId, afterId, batchSize);
      if (rows.length === 0) {
        break;
      }

      const batchFailures = await bulkIndexBatch(rows, targetIndex);
      result.failures += batchFailures;
      result.documentsIndexed += rows.length - batchFailures; // count succeeded only

      afterId = rows[rows.length - 1]._id;
      batchesCompleted += 1;

      await SearchBackfillState.updateOne(
        { companyId, index: targetIndex },
        {
          $set: { lastProcessedProjectId: afterId, batchesCompleted },
        },
      );
    }

    // Completed this company: clear the checkpoint so a future re-run starts fresh (re-indexes via deterministic _id) instead of resuming past the last _id and indexing nothing. A crash mid-run leaves the checkpoint intact to resume from — satisfies BOTH idempotent re-run and restart-safety.
    await SearchBackfillState.deleteOne({ companyId, index: targetIndex });

    result.companiesProcessed += 1;
  }

  return result;
};

// Re-exported so existing importers (e.g. test/search/backfillProjects.test.js) keep working after the shared-builder extraction.
export { buildProjectSearchDoc, toStr };
export type { ProjectAggRow, ProjectSearchDoc } from "./projectSearchDoc";

export const __test__ = { buildProjectSearchDoc, DEFAULT_TARGET_INDEX };
