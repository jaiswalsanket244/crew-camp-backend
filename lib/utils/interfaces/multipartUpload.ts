export interface IInitiateMultipartPayload {
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  chunkSizeBytes?: number;
}

export interface IInitiateMultipartResponse {
  uploadId: string;
  keyFile: string;
  chunkSizeBytes: number;
  bucketName: string;
}

export interface IGetPartUrlsPayload {
  uploadId: string;
  keyFile: string;
  partNumbers: number[];
}

export interface IPartUrlEntry {
  partNumber: number;
  url: string;
}

export interface IGetPartUrlsResponse {
  urls: IPartUrlEntry[];
  expiresInSeconds: number;
}

export interface ICompletedPart {
  partNumber: number;
  etag: string;
}

export interface ICompleteMultipartPayload {
  uploadId: string;
  keyFile: string;
  parts: ICompletedPart[];
}

export interface ICompleteMultipartResponse {
  location: string;
  returnUrl: string;
  keyFile: string;
}

export interface IListPartsQuery {
  uploadId: string;
  keyFile: string;
}

export interface IStagedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface IListPartsResponse {
  parts: IStagedPart[];
}

export interface IAbortMultipartPayload {
  uploadId: string;
  keyFile: string;
}

export interface IAbortMultipartResponse {
  aborted: true;
}
