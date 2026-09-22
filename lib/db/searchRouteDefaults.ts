import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

// Route-level default ES-read-path flag: one row per route (e.g. "projects.list", "posts.uploads"). `isSearchEnabled` falls back to this when a company has no per-company SearchFlag row, so a single flip enables ES for ALL companies — present and future — on that route, per environment (the row lives in the env's own DB). Per-company SearchFlag rows still override this (e.g. force-OFF a tenant). Default enabled:false (fail closed).
export const SearchRouteDefaultSchema = new mongoose.Schema(
  {
    route: {
      type: String,
      required: true, // canonical values: "projects.list", "posts.uploads"
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    updatedBy: {
      type: ObjectId,
      ref: "User",
      required: true, // admin user who flipped it
    },
  },
  { timestamps: true },
);

// One default row per route.
SearchRouteDefaultSchema.index({ route: 1 }, { unique: true });
