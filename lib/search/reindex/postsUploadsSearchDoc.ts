import { Posts } from "../../db";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";

// Shared source of the posts_uploads-v1 document shape + the parent-note denormalization rule. Used by BOTH the backfill and the change-stream sync so the two produce identical docs by construction — the parity gate depends on it. The index models the PostFiles (`postfiles`) document — one ES doc per file — so the consumer tails `postFiles`, NOT `Posts`. `note` is the parent Posts.note, denormalized at index time, present only when the parent is ACTIVE.

// A lean PostFiles row (the indexed entity). `note` on the file itself is its own per-file annotation — NOT the searchable note (which is the parent Posts.note).
export interface PostFileRow {
  _id: ObjectIdType;
  companyId?: ObjectIdType;
  projectId?: ObjectIdType;
  userId?: ObjectIdType;
  postId?: ObjectIdType;
  tags?: ObjectIdType[];
  status?: string;
  fileType?: string;
  createdAt?: Date;
  timestamp?: Date | null;
  position?: number;
  updatedAt?: Date;
}

// The ES _source for a posts_uploads-v1 document (mapping field set).
export interface PostUploadSearchDoc {
  companyId: string;
  projectId: string;
  userId: string;
  postId: string;
  tags: string[];
  status?: string;
  fileType?: string;
  note: string | null; // parent Posts.note — NOT PostFiles.note
  createdAt?: Date;
  timestamp?: Date | null;
  position?: number;
  mongoUpdatedAt?: Date; // PostFiles.updatedAt
}

export const toStr = (v: unknown): string => (v == null ? "" : String(v));

// Pure mapper: one PostFiles row + its parent Post's note → ES _source.
export const buildPostUploadSearchDoc = (
  file: PostFileRow,
  parentNote: string | null,
): PostUploadSearchDoc => ({
  companyId: toStr(file.companyId),
  projectId: toStr(file.projectId),
  userId: toStr(file.userId),
  postId: toStr(file.postId),
  tags: Array.isArray(file.tags) ? file.tags.map(toStr) : [],
  status: file.status,
  fileType: file.fileType,
  note: parentNote ?? null,
  createdAt: file.createdAt,
  timestamp: file.timestamp ?? null,
  position: file.position,
  mongoUpdatedAt: file.updatedAt,
});

// Batch parent-note fetch for a page's rows → Map<postIdString, note>. One query per batch (minimal round trips). Only ACTIVE parents contribute a searchable note — the getUploads note-search filters Posts.status ACTIVE (posts/helper.ts), so a non-ACTIVE parent must NOT contribute a note; absent from the map → note: null. (Backfill side.)
export const fetchActiveParentNotes = async (
  rows: PostFileRow[],
): Promise<Map<string, string | null>> => {
  const postIds = rows.map((r) => r.postId).filter(Boolean);
  const map = new Map<string, string | null>();
  if (postIds.length === 0) {
    return map;
  }
  const parents: Array<{ _id: ObjectIdType; note?: string }> = await Posts.find(
    { _id: { $in: postIds }, status: CURRENT_STATUS.ACTIVE },
    { note: 1 },
  ).lean();
  for (const parent of parents) {
    map.set(toStr(parent._id), parent.note ?? null);
  }
  return map;
};

// Single-doc parent-note fetch — the sync analog of fetchActiveParentNotes, using the IDENTICAL ACTIVE filter so sync and backfill compute the same `note`. Returns the parent Posts.note when the parent exists and is ACTIVE, else null. (Sync side.)
export const fetchActiveParentNote = async (
  postId?: ObjectIdType,
): Promise<string | null> => {
  if (!postId) {
    return null;
  }
  const parent = (await Posts.findOne(
    { _id: postId, status: CURRENT_STATUS.ACTIVE },
    { note: 1 },
  ).lean()) as { note?: string } | null;
  return parent?.note ?? null;
};
