import { ObjectIdType } from "./schemaInterface";
import { RichTextDoc } from "./dailyLog";
import { DAILY_LOG_LANGUAGE } from "../enums/dailyLog";
import { AI_PROJECT_UPDATE_STATUS } from "../enums/aiProjectUpdate";

// A photo as stored on the update. `note` and `tags` are kept so a regenerate
// after reopening has the same evidence as the first run (comments are always
// fetched live by the client). `uploadedAt` is required: the document's date
// range is derived from it.
export interface IAiProjectUpdatePhoto {
  fileId: string;
  postId: string;
  url: string;
  quickView?: string;
  order: number;
  uploadedBy?: string;
  uploadedById?: string;
  uploadedAt: string;
  note?: string;
  tags?: string[];
}

// Provenance of the last successful generation. Drives the "Drafted from N
// photos" line and the needs-review check (fileIds vs current photos).
export interface IAiProjectUpdateGeneration {
  generatedAt: Date;
  fileIds: string[];
  language: DAILY_LOG_LANGUAGE;
  photoCount: number;
  descriptionCount: number;
  commentCount: number;
}

export interface IAiProjectUpdateInput {
  projectId: string;
  schemaVersion: number;
  title: string;
  projectName: string;
  projectAddress: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  language: DAILY_LOG_LANGUAGE;
  overviewDoc: RichTextDoc | null;
  bodyText: string;
  titleEdited: boolean;
  overviewEdited: boolean;
  photos: IAiProjectUpdatePhoto[];
  generation: IAiProjectUpdateGeneration | null;
}

export interface IAiProjectUpdateCreatePayload extends IAiProjectUpdateInput {
  companyId: ObjectIdType;
  userId: ObjectIdType;
}

// A stored update, as findById returns it.
export interface IAiProjectUpdateDocument extends Omit<
  IAiProjectUpdateInput,
  "projectId"
> {
  _id: ObjectIdType;
  projectId: ObjectIdType;
  companyId: ObjectIdType;
  userId: ObjectIdType;
  status: AI_PROJECT_UPDATE_STATUS;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAiProjectUpdateListItem {
  _id: ObjectIdType;
  title: string;
  startDate: string;
  endDate: string;
  photoCount: number;
  status: AI_PROJECT_UPDATE_STATUS;
  createdAt: Date;
  updatedAt: Date;
  webUrl?: string;
}

export interface IAiProjectUpdateListPage {
  items: IAiProjectUpdateListItem[];
  total: number;
}

// ---- generation input (assembled by the client, validated here) ----

export interface IPhotoSourceComment {
  text: string;
  createdAt: string;
  isReply: boolean;
}

export interface IPhotoSource {
  fileId: string;
  postId: string;
  // YYYY-MM-DD in the request's timeZone. The prompt groups photos by it.
  dayKey: string;
  uploadedAt: string;
  note: string;
  comments: IPhotoSourceComment[];
  // Resolved tag names, not ids.
  tags: string[];
}

export interface IAiProjectUpdateGenerateInput {
  language: DAILY_LOG_LANGUAGE;
  timeZone: string;
  startDate: string;
  endDate: string;
  projectName?: string;
  projectAddress?: string;
  photos: IPhotoSource[];
}

// Both may be "" when the source text was too thin to say anything; the
// route still answers 200 and the client falls back to manual authoring.
export interface IAiProjectUpdateGenerateResult {
  title: string;
  overview: string;
}

export interface IAiProjectUpdateLLMService {
  generateProjectUpdate(
    input: IAiProjectUpdateGenerateInput,
  ): Promise<IAiProjectUpdateGenerateResult>;
}
