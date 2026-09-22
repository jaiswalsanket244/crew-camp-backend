import { Types } from "mongoose";

export interface IOfflineBundleUser {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  role?: string;
}

export interface IOfflineProjectBundle {
  details: Record<string, unknown>;
  tasks: Record<string, unknown>[];
  checklists: Record<string, unknown>[];
  uploads: Record<string, unknown>[];
}

export interface IOfflineBundleTags {
  post: Record<string, unknown>[];
  project: Record<string, unknown>[];
}

export interface IOfflineBundleResponse {
  version: string;
  projects: Record<string, IOfflineProjectBundle>;
  tags: IOfflineBundleTags;
}
