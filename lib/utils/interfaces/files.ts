import { Types } from "mongoose";
import { FileAccessType } from "../enums/files";
import { CURRENT_STATUS } from "../enums/enums";

export interface IFileCreate {
  companyId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  size: number;
  fileType: string;
  url: string;
  accessLevel: FileAccessType;
}

export interface IFileSchema extends IFileCreate {
  createdAt: Date;
  updatedAt: Date;
  status: CURRENT_STATUS;
}

export interface IFilesFetchQuery {
  companyId: Types.ObjectId;
  projectId?: Types.ObjectId;
  status: { $ne: CURRENT_STATUS };
  name?: { $regex: string; $options: "i" };
}

export interface IFileUpdate {
  name?: string;
  accessLevel?: FileAccessType;
}

export interface IPreSignedUrlPayload {
  fileName?: string;
  fileType?: string;
  // When supplied, the exact byte size is signed into the presigned URL, so S3
  // rejects a body of any other length. Optional for internal callers;
  // required on /v1, where it backs the upload size cap.
  fileSizeBytes?: number;
}

export interface IFilesDeletedFetchQuery {
  companyId: Types.ObjectId;
  projectId?: Types.ObjectId;
  status: CURRENT_STATUS;
  // Excludes rows binned as part of a whole project going to the bin.
  preDeleteStatus?: { $exists: boolean };
}

// A single post file as rendered into the selected-images PDF.
export interface IImagesPdfFile {
  _id: Types.ObjectId;
  postId?: Types.ObjectId;
  url?: string;
  userName?: string;
  location?: { lat?: number; long?: number };
  timestamp?: Date;
  uploadedAt?: Date;
  createdAt?: Date;
  // Parent post's createdAt — final fallback for the printed capture time.
  postCreatedAt?: Date;
}

export interface IImagesPdfData {
  imageData: IImagesPdfFile[];
  photosPerPage: number;
  includeFileDetails: boolean;
  projectAddress?: string;
}

// Post file fields needed to decide whether a background
// quickView (image) / thumbnail (video) variant must be generated.
export interface IMediaVariantCandidate {
  // Optional only because mongoose's insertMany return type can omit _id;
  // candidates without one are skipped.
  _id?: Types.ObjectId | string;
  url?: string;
  fileType?: string;
  quickView?: string;
  thumbnail?: string;
}
