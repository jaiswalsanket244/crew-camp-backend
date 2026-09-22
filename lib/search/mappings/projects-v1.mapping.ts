import { IndexMapping } from "../types";

// Source-of-truth mapping for the `projects` alias (concrete index projects-v1). Shape mirrors the real getAllProjectsDataV2 query fields: `archived` is denormalized from Mongo `archivedAt`; `status` and `pinnedAt` back the always-on status filter and the primary pinnedAt sort; `description`/`location` back the case-insensitive search regex. `recentPosts` is index-disabled (stored, not searchable).
export const PROJECTS_MAPPING_V1: IndexMapping = {
  settings: {
    number_of_shards: 3,
    number_of_replicas: 1,
    "index.routing.allocation.require._tier_preference": "data_content",
  },
  mappings: {
    properties: {
      companyId: { type: "keyword" }, // routing
      name: { type: "text", fields: { keyword: { type: "keyword" } } },
      description: { type: "text", fields: { keyword: { type: "keyword" } } }, // search parity
      location: { type: "text", fields: { keyword: { type: "keyword" } } }, // search parity
      archived: { type: "boolean" }, // denormalized from Mongo archivedAt
      archivedAt: { type: "date" }, // source value preserved for range queries
      tags: { type: "keyword" },
      members: { type: "keyword" },
      crews: { type: "keyword" },
      role: { type: "keyword" },
      status: { type: "keyword" }, // always-on filter
      pinnedAt: { type: "date" }, // primary sort key
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      mongoUpdatedAt: { type: "date" },
      membersCount: { type: "integer" },
      crewsCount: { type: "integer" },
      commentsCount: { type: "integer" },
      postsCount: { type: "integer" },
      recentPosts: { type: "object", enabled: false }, // stored, not searchable
    },
  },
};
