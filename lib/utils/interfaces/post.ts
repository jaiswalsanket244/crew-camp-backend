import { ObjectIdType } from "./schemaInterface";

export interface PostType {
  projectId: ObjectIdType;
  note: string;
  files?: FileType[];
}

export interface FileType {
  url: string;
  fileType: string;
  // Optional: the postfiles schema does not require either, and API callers
  // may not know a file's dimensions or capture location.
  size?: {
    width?: number;
    height?: number;
  };
  location?: {
    long?: number;
    lat?: number;
  };
  tags?: ObjectIdType[];
  note?: string;
  description?: string;
  hash?: string;
  isOriginalQuality?: string;
  position?: number;
  // Original (pre-edit) image URI from the mobile non-destructive photo editor.
  originalUri?: string;
  // Remote (S3) URL of the pre-edit file, used by the revert-to-original flow.
  originalFileUrl?: string;
  // Opaque, client-owned annotation blob for re-editable photo edits. Stored and
  // returned verbatim; the backend does not interpret its internal shape (which
  // is versioned by the client), so it is typed permissively here.
  editDocument?: Record<string, unknown>;
}

export interface IReplaceOriginalFile {
  postId: string;
  fileId: string;
  fileUrl: string;
  fileType: string;
  size: { width: number; height: number };
  annotated_by: string;
  // Current (pre-edit) url of the file, stored set-once as originalFileUrl so
  // the edit can be reverted later. Omitted by callers that aren't editing.
  previousFileUrl?: string;
  // Opaque client-owned edit blob; passed through so a replace made from the
  // mobile editor stays re-editable.
  editDocument?: Record<string, unknown>;
  originalUri?: string;
}

export interface IRevertFileToOriginal {
  postId: string;
  fileId: string;
}

export type PostFileDocument = Record<string, unknown> & {
  _id?: unknown;
  postId?: unknown;
  companyId?: unknown;
  projectId?: unknown;
  userId?: unknown;
  url?: string;
  fileType?: string;
  uploadedAt?: Date;
  size?: {
    width?: number;
    height?: number;
  };
  location?: {
    long?: number;
    lat?: number;
  };
  tags?: unknown[];
  note?: string;
  description?: string;
  quickView?: string;
  thumbnail?: string;
  timestamp?: Date;
  annotated_by?: string;
  position?: number;
  status?: string;
  hash?: string;
  isOriginalQuality?: string;
  originalUri?: string;
  originalFileUrl?: string;
  editDocument?: Record<string, unknown>;
};

export type DeletedPostFileDocument = Record<string, unknown> & {
  postId: unknown;
  projectId: unknown;
  userId: unknown;
  fileId: unknown;
  fileData: Record<string, unknown>;
  status: string;
  deletedAt: Date;
};

// GET /api/posts/uploads. Both the Mongo path (findAllUploads/getGridPosts) and the ES path (getUploadsFromES) produce this shape. A list-mode `files[]` element mirrors findAllUploads' $push (note: `fileIndex` is intentionally absent — the Mongo $push references a non-existent `$fileIndex` field, so it is omitted; replicated here for parity).
export interface UploadsFile {
  _id: ObjectIdType | string;
  url?: string;
  fileType?: string;
  uploadedAt?: Date;
  size?: { width?: number; height?: number };
  location?: { long?: number; lat?: number };
  tags?: (ObjectIdType | string)[];
  note?: string;
  description?: string;
  timestamp?: Date | null;
  noteCount?: number;
}

// One list-mode post row (matches findAllUploads' $project: _id=postId, profileImage, userName,
// files, createdAt=postCreatedAt, userId).
export interface UploadsRow {
  _id: ObjectIdType | string;
  userId?: ObjectIdType | string;
  userName?: string | null;
  profileImage?: string | null;
  createdAt?: Date | string;
  files: UploadsFile[];
}

export interface UploadsGridRow extends Omit<UploadsRow, "files"> {
  files: UploadsFile;
  projectId?: ObjectIdType;
  projectName?: string;
  fileIndex?: number;
  totalFiles?: number;
  note?: string;
  noteCount?: number;
}

export interface UploadsProjectName {
  _id: ObjectIdType;
  name?: string;
}

// The helper return shape (a one-element array). `total` is an array of `{ total }` in list mode
// (findAllUploads) but a scalar in grid mode (getGridPosts) — typed loosely to cover both.
// It also changes UNITS with the mode: distinct posts in list mode (post-collapsed pagination),
// ACTIVE files in grid mode. `totalFiles` is always a plain number and always counts ACTIVE files
// under the same filters, so callers that need file units (the Uploads tab badge, which compares
// against getProjectPhotoCount) can read it without knowing which path served the request.
export interface UploadsPage {
  items: UploadsRow[];
  total: { total: number }[] | number;
  totalFiles: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export type UploadsPathResult = UploadsPage[];

// Caller scope for an uploads read. `role` is absent for unauthenticated
// shared-link requests, where the projectId alone scopes the query.
export interface UploadsScopeUser {
  userId: ObjectIdType;
  role?: string;
  companyIds: ObjectIdType[];
}

// The PostFiles filter shared by every uploads read (list, grid and count), as
// built by PostsHelper.buildUploadsMatch. `$or` carries the text-search clause
// (post-note hits OR file-description hits), which is why it is a loose shape.
export interface UploadsFileMatch {
  status: string;
  companyId?: ObjectIdType;
  projectId?: ObjectIdType | { $in: ObjectIdType[] };
  userId?: ObjectIdType | { $in: ObjectIdType[] };
  createdAt?: { $gte: Date; $lte: Date };
  tags?: { $in: ObjectIdType[] };
  $or?: Record<string, unknown>[];
}
