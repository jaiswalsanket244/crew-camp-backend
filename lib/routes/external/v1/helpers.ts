import { Types } from "mongoose";
import { CompanyMember, Posts, Project, ProjectNotes, Tags } from "../../../db";
import { ApiKeyAuthenticatedRequest } from "../../../middleware/apiKeyAuth";
import { CURRENT_STATUS } from "../../../utils/enums/enums";
import { isValidObjectId, ObjectId } from "../../../utils/helpers/commonHelper";
import {
  IExternalFileLocation,
  IExternalFileSize,
  IExternalNoteFile,
  IExternalNoteFileInput,
  IExternalPostFile,
  IExternalPostFileInput,
  IExternalScopedNote,
  IExternalScopedPost,
  IExternalScopedProject,
} from "../../../utils/interfaces/externalApi";

// Hard caps on a single write. Large batches should be split by the caller —
// each post file is a separate document insert.
export const MAX_FILES_PER_REQUEST = 100;
export const MAX_TAGS_PER_REQUEST = 50;

export class ExternalApiHelper {
  /**
   * The tenant a request may read and write. Always taken from the API key
   * itself, never from the body, so a caller cannot address another company's
   * data by passing its id.
   */
  public static getCompanyId = (
    req: ApiKeyAuthenticatedRequest,
  ): Types.ObjectId | null => {
    const companyId = req.apiKey?.companyId ?? req.user?.companyId;
    if (!companyId) return null;
    return ObjectId(companyId.toString());
  };

  /**
   * The key owner's own role in the key's company, which gates project
   * creation. Read from CompanyMember directly rather than from
   * `req.user.companies`: ApiKeyMiddleware populates that list with every
   * active member of the company (its lookup has no userId filter), so
   * `companies[0].role` belongs to an arbitrary member, not the caller.
   */
  public static getActorRole = async (
    req: ApiKeyAuthenticatedRequest,
  ): Promise<string> => {
    const companyId = ExternalApiHelper.getCompanyId(req);
    const userId = req.apiKey?.userId ?? req.user?._id;
    if (!companyId || !userId) return "";

    const membership = await CompanyMember.findOne(
      {
        companyId,
        userId: ObjectId(userId.toString()),
        status: CURRENT_STATUS.ACTIVE,
      },
      { role: 1 },
    ).lean<{ role?: string }>();

    return membership?.role ?? "";
  };

  /**
   * Trimmed value, or null when the input isn't a non-blank string.
   *
   * node-input-validator's minLength counts raw characters, so "   " satisfies
   * `minLength:1` and then trims to "". Left unchecked that reaches Mongo as an
   * empty string — a ValidationError (surfacing as a 500) on a required path,
   * or a silently blanked field on an update, which runs no validators.
   */
  public static trimmedOrNull = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  };

  public static findScopedProject = async (
    projectId: string,
    companyId: Types.ObjectId,
  ): Promise<IExternalScopedProject | null> => {
    if (!projectId || !isValidObjectId(projectId)) return null;

    return Project.findOne(
      {
        _id: ObjectId(projectId),
        companyId,
        status: { $ne: CURRENT_STATUS.DELETED },
      },
      { companyId: 1 },
    ).lean<IExternalScopedProject>();
  };

  public static findScopedPost = async (
    postId: string,
    companyId: Types.ObjectId,
  ): Promise<IExternalScopedPost | null> => {
    if (!postId || !isValidObjectId(postId)) return null;

    return Posts.findOne(
      {
        _id: ObjectId(postId),
        companyId,
        status: { $ne: CURRENT_STATUS.DELETED },
      },
      { companyId: 1, projectId: 1, userId: 1, note: 1, createdAt: 1 },
    ).lean<IExternalScopedPost>();
  };

  /**
   * Notes carry no companyId of their own, so the tenant check goes through the
   * parent project — two indexed lookups rather than one.
   */
  public static findScopedNote = async (
    projectNoteId: string,
    companyId: Types.ObjectId,
  ): Promise<IExternalScopedNote | null> => {
    if (!projectNoteId || !isValidObjectId(projectNoteId)) return null;

    const note = await ProjectNotes.findOne(
      {
        _id: ObjectId(projectNoteId),
        status: { $ne: CURRENT_STATUS.DELETED },
      },
      { projectId: 1 },
    ).lean<IExternalScopedNote>();

    if (!note) return null;

    const project = await ExternalApiHelper.findScopedProject(
      note.projectId.toString(),
      companyId,
    );

    return project ? note : null;
  };

  /**
   * Resolves tag ids to the subset visible to the company — company-owned tags
   * plus the global defaults. Returns null when any id is unknown so the caller
   * can reject rather than silently drop it.
   */
  public static resolveTags = async (
    tags: string[],
    companyId: Types.ObjectId,
  ): Promise<Types.ObjectId[] | null> => {
    if (!tags.length) return [];
    if (tags.length > MAX_TAGS_PER_REQUEST) return null;
    if (tags.some((tag) => !isValidObjectId(tag))) return null;

    const ids = tags.map((tag) => ObjectId(tag));
    const found = await Tags.find(
      {
        _id: { $in: ids },
        $or: [{ companyId }, { companyId: { $exists: false } }],
      },
      { _id: 1 },
    ).lean<{ _id: Types.ObjectId }[]>();

    const foundIds = new Set(found.map((tag) => tag._id.toString()));
    if (tags.some((tag) => !foundIds.has(tag))) return null;

    return ids;
  };

  /**
   * Resolves contributor user ids to the subset who are active members of the
   * company. Returns null if any id isn't, so a caller can't attach arbitrary
   * users — including people from another tenant — to a checklist.
   */
  public static resolveCompanyMembers = async (
    userIds: string[],
    companyId: Types.ObjectId,
  ): Promise<Types.ObjectId[] | null> => {
    if (!userIds.length) return [];
    if (userIds.some((id) => !isValidObjectId(id))) return null;

    const ids = userIds.map((id) => ObjectId(id));
    const members = await CompanyMember.find(
      {
        companyId,
        userId: { $in: ids },
        status: CURRENT_STATUS.ACTIVE,
      },
      { userId: 1 },
    ).lean<{ userId: Types.ObjectId }[]>();

    const found = new Set(members.map((m) => m.userId.toString()));
    if (userIds.some((id) => !found.has(id))) return null;

    return ids;
  };

  private static toSize = (
    size?: IExternalFileSize,
  ): IExternalFileSize | undefined => {
    if (!size || typeof size !== "object") return undefined;
    const width = Number(size.width);
    const height = Number(size.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
    return { width, height };
  };

  private static toLocation = (
    location?: IExternalFileLocation,
  ): IExternalFileLocation | undefined => {
    if (!location || typeof location !== "object") return undefined;
    const lat = Number(location.lat);
    const long = Number(location.long);
    if (!Number.isFinite(lat) || !Number.isFinite(long)) return undefined;
    return { lat, long };
  };

  /**
   * Whitelists caller-supplied post files. `url` and `fileType` are the only
   * required fields — the url is the S3 key/CDN url handed back by the upload
   * endpoints, so nothing here reaches the bucket directly.
   */
  public static normalizePostFiles = async (
    files: IExternalPostFileInput[],
    companyId: Types.ObjectId,
  ): Promise<{ files?: IExternalPostFile[]; error?: string }> => {
    const normalized: IExternalPostFile[] = [];
    const tagIds = new Set<string>();

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!file || typeof file !== "object") {
        return { error: `files[${index}] must be an object` };
      }
      if (typeof file.url !== "string" || !file.url.trim()) {
        return { error: `files[${index}].url is required` };
      }
      if (typeof file.fileType !== "string" || !file.fileType.trim()) {
        return { error: `files[${index}].fileType is required` };
      }
      if (file.tags && !Array.isArray(file.tags)) {
        return { error: `files[${index}].tags must be an array` };
      }

      for (const tag of file.tags ?? []) {
        if (!isValidObjectId(String(tag))) {
          return { error: `files[${index}].tags contains an invalid id` };
        }
        tagIds.add(String(tag));
      }

      const timestamp = file.timestamp ? new Date(file.timestamp) : undefined;
      if (timestamp && Number.isNaN(timestamp.getTime())) {
        return { error: `files[${index}].timestamp is not a valid date` };
      }

      normalized.push({
        url: file.url.trim(),
        fileType: file.fileType.trim(),
        size: ExternalApiHelper.toSize(file.size),
        location: ExternalApiHelper.toLocation(file.location),
        note: typeof file.note === "string" ? file.note : undefined,
        description:
          typeof file.description === "string" ? file.description : undefined,
        timestamp,
        tags: (file.tags ?? []).map((tag) => ObjectId(String(tag))),
        position:
          typeof file.position === "number" && Number.isFinite(file.position)
            ? file.position
            : index,
      });
    }

    if (tagIds.size) {
      if (tagIds.size > MAX_TAGS_PER_REQUEST) {
        return { error: `at most ${MAX_TAGS_PER_REQUEST} tags per request` };
      }
      const resolved = await ExternalApiHelper.resolveTags(
        Array.from(tagIds),
        companyId,
      );
      if (!resolved) {
        return { error: "one or more tags are invalid for this company" };
      }
    }

    return { files: normalized };
  };

  // Note attachments are a much thinner shape than post files — url plus an
  // optional rendered size.
  public static normalizeNoteFiles = (
    files: IExternalNoteFileInput[],
  ): { files?: IExternalNoteFile[]; error?: string } => {
    const normalized: IExternalNoteFile[] = [];

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!file || typeof file !== "object") {
        return { error: `files[${index}] must be an object` };
      }
      if (typeof file.url !== "string" || !file.url.trim()) {
        return { error: `files[${index}].url is required` };
      }
      normalized.push({
        url: file.url.trim(),
        size: ExternalApiHelper.toSize(file.size),
      });
    }

    return { files: normalized };
  };
}
