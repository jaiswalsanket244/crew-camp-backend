import { ObjectIdType } from "./schemaInterface";
import {
  MERGE_CONFLICT_FIELD,
  MERGE_FIELD_CHOICE,
} from "../enums/projectMerge";

export interface ICompanyProjects {
  companyId: { $in: ObjectIdType[] };
  archivedAt?: { $exists: boolean };
}

// A single augmented row in the GET /api/projects/list response. Both the Mongo path (getAllProjectsDataV2 + per-row fan-out) and the ES path (getAllProjectsDataV2FromES, counts from the index) produce this shape. Base fields are loosely typed because the ES doc stores stringified ids/dates while the Mongo aggregate returns ObjectIds.
export interface ProjectListRow {
  _id: ObjectIdType | string;
  userName?: string;
  name?: string;
  location?: string;
  companyId?: ObjectIdType | string;
  tags?: (ObjectIdType | string)[];
  description?: string;
  pinnedAt?: Date | null;
  coordinates?: { latitude?: number; longitude?: number } | null;
  archivedAt?: Date | null;
  projectImage?: string;
  createdAt?: string | Date;
  members: number;
  crews: number;
  comments: number;
  posts: number;
  recentPosts: unknown[];
  isMember: boolean;
  isGuest: boolean;
  allowComment: boolean;
  canJoin: boolean;
  canAccess: boolean;
}

// The shared return shape of both the Mongo and ES read paths. `searchWithFallback<T>` uses `T = ProjectListPathResult | null` (null reproduces today's projectId-invalid "send nothing").
export interface ProjectListPathResult {
  rows: ProjectListRow[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

// --- Project merge (duplicate consolidation) ---

export interface IProjectExternalMapping {
  system?: string;
  externalId?: string;
  externalUrl?: string;
  lastOutboundSync?: Date;
  lastSyncError?: string;
}

// The identifying + conflict-eligible fields of one side of a merge, as shown in the review step.
export interface IProjectMergeSide {
  _id: ObjectIdType;
  name?: string;
  description?: string;
  location?: string;
  coordinates?: { latitude?: number; longitude?: number };
  projectImage?: string;
  tags?: ObjectIdType[];
  externalMapping?: IProjectExternalMapping;
  createdAt?: Date;
  archivedAt?: Date;
}

// A field both projects have a differing non-empty value for. The caller MUST send
// back a choice for every one of these before the merge will run.
export interface IProjectMergeConflict {
  field: MERGE_CONFLICT_FIELD;
  sourceValue: unknown;
  destinationValue: unknown;
}

// A field the destination had no value for — the source's value is carried over
// automatically, so there is nothing for the user to decide.
export interface IProjectMergeAutoFill {
  field: MERGE_CONFLICT_FIELD;
  value: unknown;
}

// Per-collection counts of what the merge will move (preview) or moved (result).
export interface IProjectMergeTransferCounts {
  posts: number;
  postFiles: number;
  files: number;
  deletedPostFiles: number;
  comments: number;
  checklists: number;
  tasks: number;
  notes: number;
  reports: number;
  invitedUsers: number;
  notifications: number;
  syncJobs: number;
  members: number;
  crews: number;
}

export interface IProjectMergePreview {
  // Explicitly labelled so the review step can never mislabel which side survives.
  keeping: IProjectMergeSide;
  archiving: IProjectMergeSide;
  conflicts: IProjectMergeConflict[];
  autoFilled: IProjectMergeAutoFill[];
  tags: { union: string[] };
  transfers: IProjectMergeTransferCounts;
  // Duplicate membership/crew rows dropped instead of moved (the destination already has them).
  duplicates: { members: number; crews: number };
}

export type IProjectMergeResolutions = Partial<
  Record<MERGE_CONFLICT_FIELD, MERGE_FIELD_CHOICE>
>;

export interface IProjectMergeResult {
  sourceProjectId: ObjectIdType;
  destinationProjectId: ObjectIdType;
  transfers: IProjectMergeTransferCounts;
  duplicates: { members: number; crews: number };
  appliedFields: string[];
  mergedAt: Date;
}
