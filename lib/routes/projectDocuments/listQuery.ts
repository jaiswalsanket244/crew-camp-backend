import { Types } from "mongoose";

// Pure, DB-free helpers for the Documents list. Kept free of ../../db so the
// tests can load them without the model graph.

export enum DOCUMENT_TYPE {
  DAILY_LOG = "dailyLog",
  PROJECT_UPDATE = "projectUpdate",
  WALKTHROUGH = "walkthrough",
  REPORT = "report",
  SHEET = "sheet",
}

export const DOCUMENT_TYPES: string[] = Object.values(DOCUMENT_TYPE);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SEARCH_MAX_LENGTH = 100;

const escapeRegExp = (input: string): string =>
  String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const escapeDocumentSearch = (search: string): string =>
  escapeRegExp(String(search).slice(0, SEARCH_MAX_LENGTH));

export const normalizeDocumentLimit = (limit?: string): number => {
  const parsed = Number.parseInt(String(limit ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

// Only the types the caller asked for; an empty or unrecognised list means all.
export const normalizeDocumentTypes = (types?: string): string[] => {
  const requested = String(types ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => DOCUMENT_TYPES.indexOf(entry) !== -1);
  return requested.length ? requested : DOCUMENT_TYPES;
};

export const normalizeDocumentAuthors = (authors?: string): string[] =>
  String(authors ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => Types.ObjectId.isValid(entry));

// Date filter, applied to the document's own date (the same value the ledger
// sorts and groups by), not to when it was last edited.
export const normalizeDocumentRange = (
  startDate?: string,
  endDate?: string,
): { from?: Date; to?: Date } => {
  const parse = (value?: string, endOfDay = false): Date | undefined => {
    if (!value) return undefined;
    const date = new Date(
      `${value}${endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}`,
    );
    return Number.isNaN(date.getTime()) ? undefined : date;
  };
  return { from: parse(startDate), to: parse(endDate, true) };
};

export interface IDocumentCursor {
  date: string;
  id: string;
}

export const encodeDocumentCursor = (cursor: IDocumentCursor): string =>
  Buffer.from(`${cursor.date}|${cursor.id}`, "utf8").toString("base64");

export const decodeDocumentCursor = (
  cursor?: string,
): IDocumentCursor | null => {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), "base64").toString("utf8");
    const separator = raw.lastIndexOf("|");
    if (separator < 1) return null;
    const date = raw.slice(0, separator);
    const id = raw.slice(separator + 1);
    if (!date || !Types.ObjectId.isValid(id)) return null;
    return { date, id };
  } catch {
    return null;
  }
};

export const cursorMatch = (
  cursor: IDocumentCursor | null,
): Record<string, unknown> | null => {
  if (!cursor) return null;
  const date = new Date(cursor.date);
  if (Number.isNaN(date.getTime())) return null;
  return {
    $or: [
      { date: { $lt: date } },
      { date, _id: { $lt: new Types.ObjectId(cursor.id) } },
    ],
  };
};
