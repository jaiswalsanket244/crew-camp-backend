import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

// Per-user project pins. Deliberately a separate collection rather than a field on
// `projects`: pin writes never touch the project document, so they emit no change-stream
// event and trigger no OpenSearch reindex. Presence of a row means pinned — unpin deletes it.
export const ProjectPinSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    projectId: {
      type: ObjectId,
      ref: "project",
      required: true,
    },
    // Denormalized so "my pins in this company" is a single index hit with no join to projects.
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: true,
    },
    pinnedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// One pin per (user, project) — makes the pin route a safe idempotent upsert.
ProjectPinSchema.index({ userId: 1, projectId: 1 }, { unique: true });
// Serves the only hot read (listPinnedProjectIds); projectId is included as a trailing key
// so that read is index-covered.
ProjectPinSchema.index({ userId: 1, companyId: 1, pinnedAt: -1, projectId: 1 });
// Cascade cleanup when a project is deleted.
ProjectPinSchema.index({ projectId: 1 });
