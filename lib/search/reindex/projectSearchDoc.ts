import { PipelineStage } from "mongoose";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";

// Shared source of the projects-v1 document shape. Used by BOTH the backfill and the change-stream sync so the two produce identical docs by construction — the parity gate depends on it. The count $lookup stages mirror getAllProjectsDataV2 / getProjectDetails (status ACTIVE everywhere; crews require an ACTIVE crew).

// One row of the parity aggregation.
export interface ProjectAggRow {
  _id: ObjectIdType;
  companyId?: ObjectIdType;
  name?: string;
  description?: string;
  location?: string;
  tags?: ObjectIdType[];
  status?: string;
  pinnedAt?: Date | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  members: ObjectIdType[];
  membersCount: number;
  crews: ObjectIdType[];
  crewsCount: number;
  commentsCount: number;
  postsCount: number;
  recentPosts: Array<{
    postId: ObjectIdType;
    createdAt?: Date;
    files: unknown[];
  }>;
}

// The ES _source for a projects-v1 document (mapping field set). `role`, `userId`, `coordinates` are intentionally absent.
export interface ProjectSearchDoc {
  companyId: string;
  name?: string;
  description?: string;
  location?: string;
  archived: boolean;
  archivedAt: Date | null;
  tags: string[];
  members: string[];
  crews: string[];
  status?: string;
  pinnedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  mongoUpdatedAt?: Date;
  membersCount: number;
  crewsCount: number;
  commentsCount: number;
  postsCount: number;
  recentPosts: Array<{ postId: string; createdAt?: Date; files: unknown[] }>;
}

export const toStr = (v: unknown): string => (v == null ? "" : String(v));

// The count $lookup sub-pipelines + the $project. Compose AFTER a caller-supplied `$match` (+ optional `$sort`/`$limit`): backfill pages by company+_id, sync matches a single `_id`. Identical stages → identical docs (parity by construction).
export const PROJECT_DOC_PIPELINE_STAGES: PipelineStage[] = [
  {
    $lookup: {
      from: "projectmembers",
      let: { projectId: "$_id" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$projectId", "$$projectId"] },
            status: CURRENT_STATUS.ACTIVE,
          },
        },
        { $project: { userId: 1 } },
      ],
      as: "memberDocs",
    },
  },
  {
    $lookup: {
      from: "crewsprojects",
      let: { projectId: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$projectId", "$$projectId"] } } },
        {
          $lookup: {
            from: "crews",
            localField: "crewId",
            foreignField: "_id",
            as: "crewDetails",
          },
        },
        { $unwind: "$crewDetails" },
        { $match: { "crewDetails.status": CURRENT_STATUS.ACTIVE } },
        { $project: { crewId: 1 } },
      ],
      as: "crewDocs",
    },
  },
  {
    $lookup: {
      from: "comments",
      let: { projectId: "$_id" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$projectId", "$$projectId"] },
            status: CURRENT_STATUS.ACTIVE,
          },
        },
        { $count: "c" },
      ],
      as: "commentAgg",
    },
  },
  {
    $lookup: {
      from: "posts",
      let: { projectId: "$_id" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$projectId", "$$projectId"] },
            status: CURRENT_STATUS.ACTIVE,
          },
        },
        { $count: "c" },
      ],
      as: "postCountAgg",
    },
  },
  {
    $lookup: {
      from: "posts",
      let: { projectId: "$_id" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$projectId", "$$projectId"] },
            status: CURRENT_STATUS.ACTIVE,
          },
        },
        { $sort: { createdAt: -1, _id: -1 } }, // _id tiebreaker → deterministic top-5
        { $limit: 5 },
        {
          $lookup: {
            from: "postfiles",
            let: { postId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$postId", "$$postId"] },
                  status: CURRENT_STATUS.ACTIVE,
                },
              },
              { $sort: { position: 1, createdAt: 1, _id: 1 } }, // _id tiebreaker
            ],
            as: "files",
          },
        },
        { $project: { postId: "$_id", createdAt: 1, files: 1 } },
      ],
      as: "recentPosts",
    },
  },
  {
    $project: {
      companyId: 1,
      name: 1,
      description: 1,
      location: 1,
      tags: 1,
      status: 1,
      pinnedAt: 1,
      archivedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      members: "$memberDocs.userId",
      membersCount: { $size: "$memberDocs" },
      crews: "$crewDocs.crewId",
      crewsCount: { $size: "$crewDocs" },
      commentsCount: { $ifNull: [{ $arrayElemAt: ["$commentAgg.c", 0] }, 0] },
      postsCount: { $ifNull: [{ $arrayElemAt: ["$postCountAgg.c", 0] }, 0] },
      recentPosts: 1,
    },
  },
];

// Pure mapper: one aggregation row → the ES _source. archived is derived from archivedAt; mongoUpdatedAt = updatedAt. No role/userId/coordinates.
export const buildProjectSearchDoc = (
  row: ProjectAggRow,
): ProjectSearchDoc => ({
  companyId: toStr(row.companyId),
  name: row.name,
  description: row.description,
  location: row.location,
  archived: !!row.archivedAt,
  archivedAt: row.archivedAt ?? null,
  tags: (row.tags ?? []).map(toStr),
  members: (row.members ?? []).map(toStr),
  crews: (row.crews ?? []).map(toStr),
  status: row.status,
  pinnedAt: row.pinnedAt ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  mongoUpdatedAt: row.updatedAt,
  membersCount: row.membersCount ?? 0,
  crewsCount: row.crewsCount ?? 0,
  commentsCount: row.commentsCount ?? 0,
  postsCount: row.postsCount ?? 0,
  recentPosts: (row.recentPosts ?? []).map((p) => ({
    postId: toStr(p.postId),
    createdAt: p.createdAt,
    files: p.files ?? [],
  })),
});
