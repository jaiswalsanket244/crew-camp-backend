import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

// Per-company × per-route ES read-path feature flag: durable Mongo source of truth for who flipped what when, read through the 30s per-pod cache in lib/search/flags.ts. Fail-closed: a missing row means enabled:false -> serve Mongo.
export const SearchFlagSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: true,
    },
    route: {
      type: String,
      required: true, // canonical values: "projects.list", "posts.uploads"
    },
    enabled: {
      type: Boolean,
      required: true,
      default: false,
    },
    updatedAt: {
      type: Date,
    },
    updatedBy: {
      type: ObjectId,
      ref: "User",
      required: true, // admin user who flipped it
    },
  },
  { timestamps: true },
);

// One flag row per (company, route). Upserted by the setFlag handler.
SearchFlagSchema.index({ companyId: 1, route: 1 }, { unique: true });
