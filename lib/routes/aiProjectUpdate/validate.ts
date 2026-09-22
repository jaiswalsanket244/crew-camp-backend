import { Types } from "mongoose";
import {
  AI_PROJECT_UPDATE_MAX_COMMENTS_PER_PHOTO,
  AI_PROJECT_UPDATE_MAX_PHOTOS,
  AI_PROJECT_UPDATE_MAX_SOURCE_CHARS,
  AI_PROJECT_UPDATE_OVERVIEW_MAX_BYTES,
  AI_PROJECT_UPDATE_TITLE_MAX_LENGTH,
} from "../../utils/enums/aiProjectUpdate";
import {
  IPhotoSource,
  IPhotoSourceComment,
} from "../../utils/interfaces/aiProjectUpdate";

// Pure validation for the project-update routes. Nothing here touches Mongo or
// the request object, so every rule is unit-testable in isolation. Each
// function returns a human-readable message (the API has no error-code
// vocabulary — status + message is the contract) or null when valid.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
};

export const isValidTimeZone = (value: unknown): value is string => {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const validateDateRange = (
  startDate: unknown,
  endDate: unknown,
): string | null => {
  if (!isIsoDay(startDate)) return "startDate must be YYYY-MM-DD";
  if (!isIsoDay(endDate)) return "endDate must be YYYY-MM-DD";
  if (startDate > endDate) return "startDate must not be after endDate";
  return null;
};

export const validateTitle = (title: unknown): string | null => {
  if (typeof title !== "string" || !title.trim()) return "title is required";
  if (title.length > AI_PROJECT_UPDATE_TITLE_MAX_LENGTH) {
    return `title must be at most ${AI_PROJECT_UPDATE_TITLE_MAX_LENGTH} characters`;
  }
  return null;
};

// 1..MAX unique, well-formed ObjectId strings. Returns the ids on success.
export const validateFileIds = (
  raw: unknown,
): { ids: string[]; error: null } | { ids: null; error: string } => {
  if (!Array.isArray(raw) || !raw.length) {
    return { ids: null, error: "Select at least one photo" };
  }
  if (raw.length > AI_PROJECT_UPDATE_MAX_PHOTOS) {
    return {
      ids: null,
      error: `A project update can include at most ${AI_PROJECT_UPDATE_MAX_PHOTOS} photos`,
    };
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !Types.ObjectId.isValid(entry)) {
      return { ids: null, error: "One or more photo ids are invalid" };
    }
    ids.push(entry);
  }
  if (new Set(ids).size !== ids.length) {
    return { ids: null, error: "Duplicate photos in selection" };
  }
  return { ids, error: null };
};

// ---- ProseMirror (TipTap) document whitelist ----
// Exactly what the editor is configured to produce: StarterKit minus
// headings/blockquote/code/rules/strike/underline/link, plus bold + italic.
const ALLOWED_NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "text",
  "bulletList",
  "orderedList",
  "listItem",
  "hardBreak",
]);
const ALLOWED_MARK_TYPES = new Set(["bold", "italic"]);
const ALLOWED_NODE_ATTRS: Record<string, Set<string>> = {
  orderedList: new Set(["start", "type"]),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkNode = (node: unknown, depth: number): string | null => {
  if (depth > 20) return "Content is nested too deeply";
  if (!isRecord(node)) return "Unsupported content";
  const type = node.type;
  if (typeof type !== "string" || !ALLOWED_NODE_TYPES.has(type)) {
    return `Unsupported content: ${String(type)}`;
  }

  if (node.attrs !== undefined) {
    if (!isRecord(node.attrs)) return "Unsupported content";
    const allowed = ALLOWED_NODE_ATTRS[type];
    for (const key of Object.keys(node.attrs)) {
      if (!allowed?.has(key)) return `Unsupported content: ${type}.${key}`;
    }
  }

  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) return "Unsupported content";
    for (const mark of node.marks) {
      if (!isRecord(mark) || typeof mark.type !== "string") {
        return "Unsupported content";
      }
      if (!ALLOWED_MARK_TYPES.has(mark.type)) {
        return `Unsupported content: mark ${mark.type}`;
      }
      if (mark.attrs !== undefined) return "Unsupported content";
    }
  }

  if (type === "text" && typeof node.text !== "string") {
    return "Unsupported content";
  }

  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return "Unsupported content";
    for (const child of node.content) {
      const error = checkNode(child, depth + 1);
      if (error) return error;
    }
  }

  return null;
};

// null is a valid (empty) overview. Anything else must be a `doc` built only
// from the whitelisted node/mark types and within the byte ceiling.
export const validateRichTextDoc = (doc: unknown): string | null => {
  if (doc === null || doc === undefined) return null;
  if (!isRecord(doc) || doc.type !== "doc") return "Unsupported content";
  const bytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
  if (bytes > AI_PROJECT_UPDATE_OVERVIEW_MAX_BYTES) {
    return "Overview is too large";
  }
  return checkNode(doc, 0);
};

// ---- generate request photos ----

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const normalizeComments = (raw: unknown): IPhotoSourceComment[] => {
  if (!Array.isArray(raw)) return [];
  const comments: IPhotoSourceComment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const text = asString(entry.text).trim();
    if (!text) continue;
    comments.push({
      text,
      createdAt: asString(entry.createdAt),
      isReply: entry.isReply === true,
    });
    if (comments.length >= AI_PROJECT_UPDATE_MAX_COMMENTS_PER_PHOTO) break;
  }
  return comments;
};

// Coerces the client's photo sources into IPhotoSource[], enforcing the same
// caps the client collector applies so a hand-rolled request cannot push an
// oversized prompt. Returns an error only for structural problems; thin
// content is reported separately by hasUsableText.
export const normalizeGeneratePhotos = (
  raw: unknown,
): { photos: IPhotoSource[]; error: null } | { photos: null; error: string } => {
  if (!Array.isArray(raw)) {
    return { photos: null, error: "photos must be an array" };
  }
  const idCheck = validateFileIds(
    raw.map((entry) => (isRecord(entry) ? entry.fileId : undefined)),
  );
  if (idCheck.error) return { photos: null, error: idCheck.error };

  const photos: IPhotoSource[] = [];
  let sourceChars = 0;
  for (const entry of raw as Record<string, unknown>[]) {
    const dayKey = entry.dayKey;
    if (!isIsoDay(dayKey)) {
      return { photos: null, error: "Each photo needs a dayKey (YYYY-MM-DD)" };
    }
    const note = asString(entry.note).trim();
    const comments = normalizeComments(entry.comments);
    const tags = Array.isArray(entry.tags)
      ? entry.tags.map((tag) => asString(tag).trim()).filter(Boolean)
      : [];

    sourceChars +=
      note.length + comments.reduce((sum, c) => sum + c.text.length, 0);
    if (sourceChars > AI_PROJECT_UPDATE_MAX_SOURCE_CHARS) {
      return { photos: null, error: "Photo notes and comments are too long" };
    }

    photos.push({
      fileId: asString(entry.fileId),
      postId: asString(entry.postId),
      dayKey,
      uploadedAt: asString(entry.uploadedAt),
      note,
      comments,
      tags,
    });
  }
  return { photos, error: null };
};

export const hasUsableText = (photos: IPhotoSource[]): boolean =>
  photos.some(
    (photo) => photo.note.length > 0 || photo.comments.length > 0 || photo.tags.length > 0,
  );

// Photos with neither a note, comments nor tags — the "partial" arithmetic.
export const countBlankPhotos = (photos: IPhotoSource[]): number =>
  photos.filter(
    (photo) => !photo.note && !photo.comments.length && !photo.tags.length,
  ).length;
