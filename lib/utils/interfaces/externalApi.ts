import { Types } from "mongoose";

// Request bodies accepted by the /v1 write endpoints. These are deliberately
// narrower than the internal shapes: the external API whitelists the fields a
// third-party integrator may set, so tenant-owned columns (companyId, status,
// externalMapping, ...) can never be written from outside.

export interface IExternalCoordinates {
  latitude?: number;
  longitude?: number;
}

export interface IExternalProjectCreateBody {
  name?: string;
  description?: string;
  location?: string;
  projectImage?: string;
  coordinates?: IExternalCoordinates;
  tags?: string[];
}

export interface IExternalProjectUpdateBody extends IExternalProjectCreateBody {
  projectId?: string;
}

// Fields of a project row the external API is allowed to $set.
export interface IExternalProjectUpdate {
  name?: string;
  description?: string;
  location?: string;
  projectImage?: string;
  coordinates?: IExternalCoordinates;
  tags?: Types.ObjectId[];
}

export interface IExternalFileSize {
  width?: number;
  height?: number;
}

export interface IExternalFileLocation {
  lat?: number;
  long?: number;
}

export interface IExternalPostFileInput {
  url?: string;
  fileType?: string;
  size?: IExternalFileSize;
  location?: IExternalFileLocation;
  note?: string;
  description?: string;
  timestamp?: string | Date;
  tags?: string[];
  position?: number;
}

// A post file after whitelisting/coercion, ready for PostFiles insertion.
export interface IExternalPostFile {
  url: string;
  fileType: string;
  size?: IExternalFileSize;
  location?: IExternalFileLocation;
  note?: string;
  description?: string;
  timestamp?: Date;
  tags?: Types.ObjectId[];
  position?: number;
}

export interface IExternalPostCreateBody {
  projectId?: string;
  note?: string;
  files?: IExternalPostFileInput[];
}

export interface IExternalPostFilesBody {
  postId?: string;
  files?: IExternalPostFileInput[];
}

export interface IExternalNoteFileInput {
  url?: string;
  size?: IExternalFileSize;
}

export interface IExternalNoteFile {
  url: string;
  size?: IExternalFileSize;
}

export interface IExternalProjectNoteCreateBody {
  projectId?: string;
  note?: string;
  files?: IExternalNoteFileInput[];
}

export interface IExternalProjectNoteUpdateBody {
  projectNoteId?: string;
  note?: string;
  files?: IExternalNoteFileInput[];
}

// Fields of a project note the external API is allowed to $set.
export interface IExternalProjectNoteUpdate {
  note?: string;
  files?: IExternalNoteFile[];
}

// Minimal projections the scope guards return.
export interface IExternalScopedProject {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
}

export interface IExternalScopedPost {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  note?: string;
  createdAt: Date;
}

export interface IExternalScopedNote {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
}

// One tracked /v1 upload, written when the presigned URL is handed out.
export interface IPendingUploadRecord {
  companyId: Types.ObjectId;
  userId: Types.ObjectId;
  keyFile: string;
  url?: string;
  fileType: string;
  sizeBytes?: number;
  uploadId?: string;
}

// A multipart upload S3 still holds staged parts for.
export interface IStaleMultipartUpload {
  uploadId: string;
  keyFile: string;
  initiatedAt?: Date;
}

// --- Checklists -------------------------------------------------------------

export interface IExternalChecklistPhoto {
  imageData?: {
    url?: string;
    fileType?: string;
    size?: IExternalFileSize;
  };
}

// The same photo after validation. Mirrors TaskV2PayloadType's own shape, which
// treats dimensions as required for checklist task images.
export interface IExternalChecklistPhotoOutput {
  imageData: {
    url: string;
    fileType: string;
    size: { width: number; height: number };
  };
}

export interface IExternalChecklistTaskInput {
  name?: string;
  description?: string;
  sortOrder?: number;
  photosRequired?: boolean;
  fields?: unknown[];
  taskImages?: IExternalChecklistPhoto[];
}

export interface IExternalChecklistCreateBody {
  projectId?: string;
  name?: string;
  type?: string;
  contributors?: string[];
  tasks?: IExternalChecklistTaskInput[];
}
