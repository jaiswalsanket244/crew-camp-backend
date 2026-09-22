import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import { STATUS } from "../utils/enums/enums";
import { INTEGRATION_PROVIDERS } from "../utils/enums/integrations";

export const ProjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      mockName: "name",
    },
    description: {
      type: String,
    },
    location: {
      type: String,
      required: false,
    },
    coordinates: {
      latitude: { type: Number },
      longitude: { type: Number },
    },
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: false,
    },
    status: {
      type: String,
      enum: STATUS,
      default: "ACTIVE",
    },
    projectImage: {
      type: String,
      required: false,
    },
    userId: {
      type: ObjectId,
      ref: "users",
      required: false,
    },
    tags: [
      {
        type: ObjectId,
        ref: "tags",
      },
    ],
    pinnedAt: {
      type: Date,
    },
    // When the project was moved to the bin. Explicit rather than reusing
    // updatedAt, which any later write would reset and so push the purge back.
    deletedAt: {
      type: Date,
      required: false,
    },
    archivedAt: {
      type: Date,
    },
    // Duplicate consolidation: set on the SOURCE project when it is merged into
    // another one. The source is archived and kept as a pointer to the surviving
    // project so its history stays traceable (see lib/routes/projects/merge.ts).
    mergedInto: {
      type: ObjectId,
      ref: "project",
      required: false,
    },
    mergedAt: {
      type: Date,
    },
    mergedBy: {
      type: ObjectId,
      ref: "User",
      required: false,
    },
    // CRM integration mapping
    externalMapping: {
      system: {
        type: String,
        enum: INTEGRATION_PROVIDERS,
        required: false,
      },
      externalId: {
        type: String,
        required: false,
      },
      externalUrl: {
        type: String,
        required: false,
      },
      lastOutboundSync: {
        type: Date,
        required: false,
      },
      lastSyncError: {
        type: String,
        required: false,
      },
    },
  },
  { timestamps: true },
);

ProjectSchema.index({ companyId: 1 });
ProjectSchema.index({ companyId: 1, status: 1, createdAt: -1 });
// Backs `{ companyId } sort createdAt desc` (getCompanyProjects / getRecentCompanyProjectIds); the status-less query can't use the {companyId,status,createdAt} index, so without this it does a full in-memory sort of a tenant's projects.
ProjectSchema.index({ companyId: 1, createdAt: -1 });

// Unique constraint for external mappings (prevent duplicate projects for same CRM job).
// Partial so projects with no externalId are unconstrained. $type: "string" is used instead of
// { $exists: true, $ne: null } because $ne is not a legal partialFilterExpression operator —
// MongoDB rejects the index outright, which silently left this constraint unenforced.
ProjectSchema.index(
  {
    companyId: 1,
    "externalMapping.system": 1,
    "externalMapping.externalId": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "externalMapping.externalId": { $type: "string" },
      "externalMapping.system": { $type: "string" },
    },
  },
);
