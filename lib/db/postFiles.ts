import * as mongoose from "mongoose";
import { CURRENT_STATUS } from "../utils/enums/enums";

const ObjectId = mongoose.Schema.Types.ObjectId;

export const PostFilesSchema = new mongoose.Schema(
  {
    postId: {
      type: ObjectId,
      ref: "post",
      required: true,
      index: true,
    },
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    projectId: {
      type: ObjectId,
      ref: "project",
      required: true,
      index: true,
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    url: { type: String },
    fileType: { type: String },
    uploadedAt: { type: Date },
    size: {
      width: Number,
      height: Number,
    },
    location: {
      long: Number,
      lat: Number,
    },
    tags: [
      {
        type: ObjectId,
        ref: "tags",
        required: false,
      },
    ],
    note: {
      type: String,
      required: false,
    },
    description: {
      type: String,
      required: false,
    },
    quickView: { type: String },
    thumbnail: { type: String },
    timestamp: { type: Date },
    annotated_by: {
      type: String,
      required: false,
    },
    // Preserves intra-post ordering (mirrors the previous array index).
    position: {
      type: Number,
      default: 0,
      index: true,
    },
    // Post's anchor date (min createdAt of its files ≈ post.createdAt),
    // persisted so the uploads v2 feed can paginate on an index instead of
    // computing it per-request via $setWindowFields. Write paths set it from
    // the parent post; the pre-hooks default it to the file's own createdAt.
    // Backfill + compound indexes: scripts/backfillPostSortDate.js — indexes
    // are intentionally NOT declared here so a deploy can't trigger an
    // autoIndex build on this collection.
    postSortDate: { type: Date },
    status: {
      type: String,
      enum: CURRENT_STATUS,
      default: CURRENT_STATUS.ACTIVE,
    },
    // Set when this row was soft-deleted as part of its project going to the
    // bin, holding the status it had beforehand. Presence means "deleted with
    // the project" (so per-entity bins hide it); the value is what a project
    // restore puts back, which matters for PENDING/COMPLETED rows.
    preDeleteStatus: {
      type: String,
      required: false,
    },
    commentCount: {
      type: Number,
      default: 0,
    },
    isOriginalQuality: {
      type: String,
      required: false,
    },
    hash: {
      type: String,
      required: false,
    },
    // Original (pre-edit) image URI, sent by the mobile non-destructive photo editor.
    originalUri: {
      type: String,
      required: false,
    },
    // Remote (S3) URL of the pre-edit file, so an edit can be reverted from any
    // client. Written SET-ONCE on the first edit-replace and never overwritten,
    // so revert always restores the true original rather than the previous edit.
    // Unlike originalUri (a device-local path owned by the mobile editor), this
    // is fetchable by every client. Absent on files edited before this shipped.
    originalFileUrl: {
      type: String,
      required: false,
    },
    // Opaque, forward-compatible annotation blob for re-editable photo edits
    // (crop/rotation/shapes/texts/freehand). Stored verbatim; backend does not
    // interpret its internal shape, which is owned and versioned by the client.
    editDocument: {
      type: mongoose.Schema.Types.Mixed,
      required: false,
    },
  },
  { timestamps: true, collection: "postfiles" },
);

PostFilesSchema.index({ postId: 1, position: 1 });
PostFilesSchema.index({ projectId: 1, status: 1, createdAt: -1 });
PostFilesSchema.index({ companyId: 1, status: 1, createdAt: -1 });
PostFilesSchema.index({
  companyId: 1,
  status: 1,
  timestamp: -1,
  createdAt: -1,
});
PostFilesSchema.index({ tags: 1 });

interface IPostFileHookDoc {
  postId?: unknown;
  createdAt?: Date;
  timestamp?: Date;
  postSortDate?: Date;
}

interface IPostFileSiblingModel {
  findOne(
    filter: Record<string, unknown>,
    projection: Record<string, number>,
  ): {
    sort(spec: Record<string, number>): {
      lean(): Promise<{ postSortDate?: Date; createdAt?: Date } | null>;
    };
  };
}

// Files added to an EXISTING post must inherit its anchor date, otherwise
// they'd sort apart from their siblings in the uploads v2 feed. One indexed
// findOne per insert; returns null for brand-new posts.
const resolveExistingPostAnchor = async (
  model: IPostFileSiblingModel,
  postId: unknown,
): Promise<Date | null> => {
  if (!postId) return null;
  const sibling = await model
    .findOne({ postId }, { postSortDate: 1, createdAt: 1 })
    .sort({ position: 1, _id: 1 })
    .lean();
  return sibling?.postSortDate || sibling?.createdAt || null;
};

const minCreatedAt = (docs: IPostFileHookDoc[]): Date | null => {
  let min: Date | null = null;
  for (const d of docs) {
    const created = d?.createdAt ? new Date(d.createdAt) : null;
    if (created && (!min || created < min)) min = created;
  }
  return min;
};

PostFilesSchema.pre("save", async function (this: any) {
  if (!this.timestamp) {
    this.timestamp = this.createdAt || new Date();
  }
  if (!this.postSortDate) {
    const anchor = await resolveExistingPostAnchor(
      this.constructor as IPostFileSiblingModel,
      this.postId,
    );
    this.postSortDate = anchor || this.createdAt || new Date();
  }
});
PostFilesSchema.pre(
  "insertMany",
  function (next: (err?: Error) => void, docs: IPostFileHookDoc[]) {
    const now = new Date();
    if (!Array.isArray(docs)) return next();
    for (const d of docs) {
      if (d && !d.timestamp) d.timestamp = d.createdAt || now;
    }
    const missing = docs.filter((d) => d && !d.postSortDate);
    if (!missing.length) return next();

    // Group by postId: one sibling lookup per post, min-of-batch fallback for
    // posts being created right now (matches v1's min-file-createdAt anchor).
    const byPost = new Map<string, IPostFileHookDoc[]>();
    const groups: IPostFileHookDoc[][] = [];
    for (const d of missing) {
      const key = String(d.postId ?? "");
      const group = byPost.get(key);
      if (group) group.push(d);
      else {
        const created = [d];
        byPost.set(key, created);
        groups.push(created);
      }
    }
    (async () => {
      for (const group of groups) {
        const anchor =
          (await resolveExistingPostAnchor(
            this as unknown as IPostFileSiblingModel,
            group[0].postId,
          )) ||
          minCreatedAt(group) ||
          now;
        for (const d of group) d.postSortDate = anchor;
      }
    })().then(
      () => next(),
      (err: Error) => next(err),
    );
  },
);
