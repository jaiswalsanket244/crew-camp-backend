import { PipelineStage, Types } from "mongoose";

import {
  AiProjectUpdates,
  DailyLogs,
  ProjectReports,
  Sheets,
  User,
} from "../../db";
import { DAILY_LOG_STATUS } from "../../utils/enums/dailyLog";
import { AI_PROJECT_UPDATE_STATUS } from "../../utils/enums/aiProjectUpdate";
import { REPORT_SOURCE, REPORT_STATUS } from "../../utils/enums/projectReports";
import { SHEET_STATUS } from "../../utils/enums/sheet";
import {
  DOCUMENT_TYPE,
  IDocumentCursor,
  cursorMatch,
  escapeDocumentSearch,
} from "./listQuery";

type mongoId = Types.ObjectId;

// One row of the ledger, whatever collection it came from.
export interface IDocumentRow {
  _id: mongoId;
  type: DOCUMENT_TYPE;
  title: string;
  date: Date;
  photoCount: number | null;
  userId?: mongoId;
  excerpt?: string;
  author?: string;
}

interface IListArgs {
  projectId: mongoId;
  companyId: mongoId;
  types: string[];
  search?: string;
  authors: mongoId[];
  range: { from?: Date; to?: Date };
  limit: number;
  cursor: IDocumentCursor | null;
}

const LAST_TOUCHED = { $ifNull: ["$updatedAt", "$createdAt"] };
const authorMatch = (authors: mongoId[]) =>
  authors.length ? { userId: { $in: authors } } : {};

const titleMatch = (field: string, search?: string) => {
  const trimmed = search?.trim();
  if (!trimmed) return {};
  const rx = { $regex: escapeDocumentSearch(trimmed), $options: "i" };
  return { $or: [{ [field]: rx }, { bodyText: rx }] };
};

export class ProjectDocumentHelpers {
  private static branch = (args: {
    match: Record<string, unknown>;
    type: DOCUMENT_TYPE;
    titleField: string;
    date: unknown;
    photoCount: unknown;
  }): (PipelineStage.Match | PipelineStage.Project)[] => [
    { $match: args.match },
    {
      $project: {
        _id: 1,
        type: { $literal: args.type },
        title: { $ifNull: [`$${args.titleField}`, ""] },
        date: args.date,
        photoCount: args.photoCount,
        userId: 1,
      },
    },
  ];

  // Total matching the filters, ignoring the cursor: the tab badge needs the
  // real number, not how many rows happen to be loaded.
  public static count = async (args: Omit<IListArgs, "limit" | "cursor">) => {
    const rows = (await DailyLogs.aggregate([
      ...ProjectDocumentHelpers.pipelineFor(args),
      { $count: "total" },
    ])) as { total?: number }[];
    return rows[0]?.total ?? 0;
  };

  private static pipelineFor = (
    args: Omit<IListArgs, "limit" | "cursor">,
  ): PipelineStage[] => {
    const { projectId, companyId, types, search, authors, range } = args;
    const byAuthor = authorMatch(authors);
    const wanted = (type: DOCUMENT_TYPE) => types.indexOf(type) !== -1;

    const unions: PipelineStage[] = [];

    if (wanted(DOCUMENT_TYPE.PROJECT_UPDATE)) {
      unions.push({
        $unionWith: {
          coll: AiProjectUpdates.collection.name,
          pipeline: ProjectDocumentHelpers.branch({
            match: {
              projectId,
              companyId,
              status: { $ne: AI_PROJECT_UPDATE_STATUS.DELETED },
              ...byAuthor,
              ...titleMatch("title", search),
            },
            type: DOCUMENT_TYPE.PROJECT_UPDATE,
            titleField: "title",
            date: LAST_TOUCHED,
            photoCount: { $size: { $ifNull: ["$photos", []] } },
          }),
        },
      });
    }

    if (wanted(DOCUMENT_TYPE.SHEET)) {
      unions.push({
        $unionWith: {
          coll: Sheets.collection.name,
          pipeline: ProjectDocumentHelpers.branch({
            match: {
              projectId,
              companyId,
              status: { $ne: SHEET_STATUS.DELETED },
              ...byAuthor,
              ...titleMatch("title", search),
            },
            type: DOCUMENT_TYPE.SHEET,
            titleField: "title",
            date: LAST_TOUCHED,
            photoCount: { $size: { $ifNull: ["$photos", []] } },
          }),
        },
      });
    }

    const reportTypes: { type: DOCUMENT_TYPE; source: string }[] = [];
    if (wanted(DOCUMENT_TYPE.WALKTHROUGH)) {
      reportTypes.push({
        type: DOCUMENT_TYPE.WALKTHROUGH,
        source: REPORT_SOURCE.AI,
      });
    }
    if (wanted(DOCUMENT_TYPE.REPORT)) {
      reportTypes.push({
        type: DOCUMENT_TYPE.REPORT,
        source: REPORT_SOURCE.MANUAL,
      });
    }
    reportTypes.forEach((entry) => {
      unions.push({
        $unionWith: {
          coll: ProjectReports.collection.name,
          pipeline: ProjectDocumentHelpers.branch({
            match: {
              projectId,
              companyId,
              status: { $ne: REPORT_STATUS.DELETED },
              reportSource:
                entry.source === REPORT_SOURCE.AI
                  ? REPORT_SOURCE.AI
                  : { $ne: REPORT_SOURCE.AI },
              ...byAuthor,
              ...titleMatch("reportName", search),
            },
            type: entry.type,
            titleField: "reportName",
            date: LAST_TOUCHED,
            photoCount: { $literal: null },
          }),
        },
      });
    });

    const seedMatch = wanted(DOCUMENT_TYPE.DAILY_LOG)
      ? {
          projectId,
          companyId,
          status: { $ne: DAILY_LOG_STATUS.DELETED },
          ...byAuthor,
          ...titleMatch("title", search),
        }
      : { _id: { $exists: false } };

    const rangeMatch: Record<string, unknown> = {};
    if (range.from) rangeMatch.$gte = range.from;
    if (range.to) rangeMatch.$lte = range.to;
    const withinRange = Object.keys(rangeMatch).length
      ? [{ $match: { date: rangeMatch } } as PipelineStage.Match]
      : [];

    return [
      ...ProjectDocumentHelpers.branch({
        match: seedMatch,
        type: DOCUMENT_TYPE.DAILY_LOG,
        titleField: "title",
        date: LAST_TOUCHED,
        photoCount: { $size: { $ifNull: ["$photos", []] } },
      }),
      ...unions,
      ...withinRange,
    ];
  };

  public static list = async (args: IListArgs) => {
    const after = cursorMatch(args.cursor);

    return (await DailyLogs.aggregate([
      ...ProjectDocumentHelpers.pipelineFor(args),
      ...(after ? [{ $match: after } as PipelineStage.Match] : []),
      { $sort: { date: -1, _id: -1 } } as PipelineStage.Sort,
      { $limit: args.limit + 1 },
    ])) as IDocumentRow[];
  };

  public static decorate = async (rows: IDocumentRow[]) => {
    const idsOfType = (type: DOCUMENT_TYPE) =>
      rows.filter((row) => row.type === type).map((row) => row._id);

    const [logs, updates, sheets, authors] = await Promise.all([
      DailyLogs.find(
        { _id: { $in: idsOfType(DOCUMENT_TYPE.DAILY_LOG) } },
        { overviewDoc: 1 },
      ).lean(),
      AiProjectUpdates.find(
        { _id: { $in: idsOfType(DOCUMENT_TYPE.PROJECT_UPDATE) } },
        { overviewDoc: 1 },
      ).lean(),
      Sheets.find(
        { _id: { $in: idsOfType(DOCUMENT_TYPE.SHEET) } },
        { bodyDoc: 1 },
      ).lean(),
      User.find(
        {
          _id: {
            $in: Array.from(
              new Set(
                rows.map((row) => String(row.userId ?? "")).filter(Boolean),
              ),
            ),
          },
        },
        { name: 1 },
      ).lean(),
    ]);

    const bodies = new Map<string, unknown>();
    logs.forEach((doc) => bodies.set(String(doc._id), doc.overviewDoc));
    updates.forEach((doc) => bodies.set(String(doc._id), doc.overviewDoc));
    sheets.forEach((doc) => bodies.set(String(doc._id), doc.bodyDoc));

    const names = new Map<string, string>();
    authors.forEach((user) => {
      const full = [user?.name?.first, user?.name?.last]
        .filter(Boolean)
        .join(" ");
      names.set(String(user._id), full);
    });

    return rows.map((row) => ({
      ...row,
      excerpt: richTextExcerpt(bodies.get(String(row._id))),
      author: names.get(String(row.userId ?? "")) ?? "",
    }));
  };
}

const EXCERPT_MAX_CHARS = 90;

export const richTextExcerpt = (doc: unknown): string => {
  if (!doc || typeof doc !== "object") return "";
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (parts.join(" ").length > EXCERPT_MAX_CHARS) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const entry = node as { text?: unknown; content?: unknown };
    if (typeof entry.text === "string") parts.push(entry.text);
    if (entry.content) walk(entry.content);
  };

  walk((doc as { content?: unknown }).content);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= EXCERPT_MAX_CHARS) return text;
  return `${text.slice(0, EXCERPT_MAX_CHARS).trimEnd()}…`;
};
