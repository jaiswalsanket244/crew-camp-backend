import { ObjectIdType } from "./schemaInterface";
import { DAILY_LOG_LANGUAGE, DAILY_LOG_STATUS } from "../enums/dailyLog";

// Rich-text fields are stored as ProseMirror (TipTap) JSON, never as HTML —
// the shape is editor-owned, so it stays an opaque object here.
export type RichTextDoc = Record<string, unknown>;

export interface IDailyLogContributor {
  userId?: ObjectIdType | string;
  name: string;
}

export interface IDailyLogPhoto {
  fileId: string;
  postId: string;
  url: string;
  quickView?: string;
  order: number;
  tags?: string[];
  description?: string;
  uploadedBy?: string;
  uploadedById?: string;
  uploadedAt?: string;
}

export interface IDailyLogTodo {
  text: string;
  done: boolean;
  source?: "ai" | "user";
}

export interface IDailyLogInput {
  projectId: string;
  schemaVersion: number;
  title: string;
  projectName: string;
  projectAddress: string;
  summaryDate: string;
  language: DAILY_LOG_LANGUAGE;
  contributors: IDailyLogContributor[];
  overviewDoc: RichTextDoc | null;
  photos: IDailyLogPhoto[];
  todos: IDailyLogTodo[];
  notesDoc: RichTextDoc | null;
  bodyText: string;
  generatedFromFileIds?: string[];
}

export interface IDailyLogCreatePayload extends IDailyLogInput {
  companyId: ObjectIdType;
  userId: ObjectIdType;
}

// Company + author details stamped on the PDF header.
export interface IDailyLogBranding {
  companyName: string;
  companyLogo: string;
  filedBy: string;
}

// A stored daily log, as findById returns it.
export interface IDailyLogDocument extends Omit<IDailyLogInput, "projectId"> {
  _id: ObjectIdType;
  projectId: ObjectIdType;
  companyId: ObjectIdType;
  userId: ObjectIdType;
  status: DAILY_LOG_STATUS;
  createdAt: Date;
  updatedAt: Date;
}

export interface IDailyLogListItem {
  _id: ObjectIdType;
  title: string;
  summaryDate: string;
  photoCount: number;
  status: DAILY_LOG_STATUS;
  createdAt: Date;
  updatedAt: Date;
  webUrl?: string;
}

export type DailyLogSection = "overview" | "todos";

export type DailyLogGenerateMode = "full" | "append";

export interface IDailyLogGeneratePhoto {
  fileId: string;
  postId?: string;
  isNew?: boolean;
  description: string;
  tags?: string[];
  takenAt?: string;
}

export interface IDailyLogGenerateInput {
  date: string;
  language: DAILY_LOG_LANGUAGE;
  sections: DailyLogSection[];
  photos: IDailyLogGeneratePhoto[];
  projectName?: string;
  projectAddress?: string;
  mode?: DailyLogGenerateMode;
  existingOverview?: string;
  existingTodos?: string[];
}

export interface IDailyLogGenerateResult {
  overview?: string;
  todos?: string[];
  overviewAddition?: string;
  todoAdditions?: string[];
}

export interface IDailyLogLLMService {
  generateDailyLog(
    input: IDailyLogGenerateInput,
  ): Promise<IDailyLogGenerateResult>;
}
