import { PipelineStage } from "mongoose";
import { Project } from "../../db";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { emitIndexingLag } from "../emitMetric";
import { SearchClientService } from "../searchClient";
import {
  PROJECT_DOC_PIPELINE_STAGES,
  ProjectAggRow,
  buildProjectSearchDoc,
  toStr,
} from "../reindex/projectSearchDoc";
import { recentPostsHelper } from "./recentPostsHelper";

const PROJECTS_ALIAS = "projects";

// null-guarded painless increment for a denormalized count (params.d = +1 / -1).
const countIncrScript = (field: string): string =>
  `ctx._source.${field} = (ctx._source.${field} == null ? 0 : ctx._source.${field}) + params.d`;

// Minimal structural shape of a Mongo change-stream event (the fields these handlers
// read). Structurally compatible with mongodb's ChangeStreamDocument; defined
// locally to avoid a direct `mongodb` import and the full discriminated union.
export interface MongoChangeEvent {
  operationType: string;
  documentKey?: { _id: ObjectIdType };
  fullDocument?:
    | ({ companyId?: ObjectIdType } & Record<string, unknown>)
    | null;
}

const isUpsertOp = (op: string): boolean =>
  op === "insert" || op === "update" || op === "replace";

// Re-derives a project's full ES doc from Mongo (the SAME pipeline + mapper as the backfill → parity by construction) and upserts it via `index` (deterministic _id = idempotent). Routing comes from the re-derived doc's companyId — related-collection events (members/crews) carry no companyId, so it must NOT come from the event. Skips if the project no longer exists. Shared by applyProjectChange + the member/crew consumers (full re-derivation, low-frequency strategy).
export const reindexProjectById = async (
  projectId: ObjectIdType,
  sourceUpdatedAt?: Date,
): Promise<void> => {
  const pipeline: PipelineStage[] = [
    { $match: { _id: projectId } },
    ...PROJECT_DOC_PIPELINE_STAGES,
  ];
  const rows: ProjectAggRow[] = await Project.aggregate(pipeline);
  if (rows.length === 0) {
    return; // project deleted between the event and this lookup — skip
  }
  const doc = buildProjectSearchDoc(rows[0]);
  await SearchClientService.getInstance().index({
    index: PROJECTS_ALIAS,
    id: toStr(projectId),
    routing: doc.companyId,
    body: doc as unknown as Record<string, unknown>,
  });
  // Lag from the triggering write — the project's own updatedAt for its own change, or the related-collection event's updatedAt (passed in) for member/crew.
  emitIndexingLag(PROJECTS_ALIAS, sourceUpdatedAt ?? doc.mongoUpdatedAt);
};

// Applies one Projects change-stream event to the `projects` ES alias. insert/update/replace → full re-derivation via reindexProjectById. delete → remove by _id with deleteByQuery (routing-agnostic: a delete event carries no companyId, so a routed `delete` would hit the wrong shard).
export const applyProjectChange = async (
  event: MongoChangeEvent,
): Promise<void> => {
  const docId = event.documentKey?._id;
  if (!docId) {
    return; // defensive — no document key, nothing to apply
  }

  if (event.operationType === "delete") {
    await SearchClientService.getInstance().deleteByQuery({
      index: PROJECTS_ALIAS,
      body: { query: { ids: { values: [toStr(docId)] } } },
    });
    return;
  }

  if (isUpsertOp(event.operationType)) {
    await reindexProjectById(docId);
    return;
  }

  // Other operationTypes (drop, dropDatabase, rename, invalidate) → ignore.
};

// ── Related-collection denormalization consumers (projects index) ──

// ProjectMembers change → full re-derivation of the affected project (membersCount). Member add/remove is a soft `findOneAndUpdate` (an `update` event with fullDocument), so insert/update/replace cover the common path; a hard delete (bulk user/project cleanup) carries no projectId → skip (Phase-2 drift reconciles). NOTE: CompanyMembers is deliberately NOT watched — the shipped pipeline counts `projectmembers` ONLY.
export const applyMemberChange = async (
  event: MongoChangeEvent,
): Promise<void> => {
  if (!isUpsertOp(event.operationType)) {
    return; // delete events carry no projectId — Phase-2 drift reconciles
  }
  const projectId = event.fullDocument?.projectId as ObjectIdType | undefined;
  if (!projectId) {
    return;
  }
  await reindexProjectById(
    projectId,
    event.fullDocument?.updatedAt as Date | undefined,
  );
};

// CrewsProjects change → full re-derivation of the affected project (crewsCount). Crew-add is `insertMany` (insert events). Crew-remove is `deleteMany` (a hard delete — the join has no status field) → no projectId → skip (crewsCount drifts until a reindex / Phase-2 drift). A `crews.status` flip also drifts (crews is not watched). Both are reconciled by the Phase-2 drift cron.
export const applyCrewProjectChange = async (
  event: MongoChangeEvent,
): Promise<void> => {
  if (!isUpsertOp(event.operationType)) {
    return;
  }
  const projectId = event.fullDocument?.projectId as ObjectIdType | undefined;
  if (!projectId) {
    return;
  }
  await reindexProjectById(
    projectId,
    event.fullDocument?.updatedAt as Date | undefined,
  );
};

// Comments change → incremental commentsCount partial-update (high-frequency). Only comments WITH a projectId count toward a project (the pipeline matches comments by projectId; post-scoped comments do not). Comments carry no companyId and the index is companyId-routed, so resolve companyId via a Project lookup. insert → +1. A hard delete (findByIdAndDelete) carries no projectId → skip (commentsCount drifts up until Phase-2 drift). No upsert: a missing project doc → 404 → poison-skip.
export const applyCommentChange = async (
  event: MongoChangeEvent,
): Promise<void> => {
  if (event.operationType !== "insert") {
    return; // delete/update → Phase-2 drift (delete events carry no projectId)
  }
  const projectId = event.fullDocument?.projectId as ObjectIdType | undefined;
  if (!projectId) {
    return; // post-scoped comment — does not affect a project's commentsCount
  }
  const parent = (await Project.findOne(
    { _id: projectId },
    { companyId: 1 },
  ).lean()) as { companyId?: ObjectIdType } | null;
  const companyId = toStr(parent?.companyId);
  if (!companyId) {
    return; // project gone / unroutable — drift reconciles
  }
  await SearchClientService.getInstance().update({
    index: PROJECTS_ALIAS,
    id: toStr(projectId),
    routing: companyId,
    retry_on_conflict: 3,
    body: {
      script: {
        lang: "painless",
        source: countIncrScript("commentsCount"),
        params: { d: 1 },
      },
    },
  });
  emitIndexingLag(
    PROJECTS_ALIAS,
    event.fullDocument?.updatedAt as Date | undefined,
  );
};

// Posts change → high-frequency denormalization of the `projects` index. insert → incremental postsCount += 1 + recentPostsHelper (routing from the post's own companyId, no lookup). update/replace → full re-derivation via reindexProjectById: a post soft-delete (status→DELETED), restore (→ACTIVE), or edit arrives as an `update`, and the reindex re-derives postsCount (ACTIVE-only) + recentPosts idempotently — dropping a deleted post from both. A hard delete carries no projectId → skip (Phase-2 drift reconciles).
export const applyPostChange = async (
  event: MongoChangeEvent,
): Promise<void> => {
  const projectId = event.fullDocument?.projectId as ObjectIdType | undefined;

  if (event.operationType === "insert") {
    const docId = event.documentKey?._id;
    const companyId = event.fullDocument?.companyId;
    if (!docId || !projectId || !companyId) {
      return;
    }
    await SearchClientService.getInstance().update({
      index: PROJECTS_ALIAS,
      id: toStr(projectId),
      routing: toStr(companyId),
      retry_on_conflict: 3,
      body: {
        script: {
          lang: "painless",
          source: countIncrScript("postsCount"),
          params: { d: 1 },
        },
      },
    });
    await recentPostsHelper({
      _id: docId,
      projectId,
      companyId,
      createdAt: event.fullDocument?.createdAt as Date | undefined,
    });
    emitIndexingLag(
      PROJECTS_ALIAS,
      event.fullDocument?.updatedAt as Date | undefined,
    );
    return;
  }

  if (event.operationType === "update" || event.operationType === "replace") {
    if (!projectId) {
      return;
    }
    await reindexProjectById(
      projectId,
      event.fullDocument?.updatedAt as Date | undefined,
    );
    return;
  }

  // Hard delete (no projectId) / other ops → skip (Phase-2 drift reconciles).
};
