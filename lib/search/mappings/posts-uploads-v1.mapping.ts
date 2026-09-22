import { IndexMapping } from "../types";

// Source-of-truth mapping for the `posts_uploads` alias (concrete index posts_uploads-v1). Models the PostFiles (`postfiles`) document — NOT Posts — because both getUploads helpers $match on PostFiles. Field set is the real getUploads filter/sort fields: postedAt → createdAt (+ timestamp), members → userId (the uploader), archived → status. `note` is DENORMALIZED from the parent Posts.note at index time (ES has no efficient cross-index join); `fileType` is projected in every response.
export const POSTS_UPLOADS_MAPPING_V1: IndexMapping = {
  settings: {
    number_of_shards: 3,
    number_of_replicas: 1,
  },
  mappings: {
    properties: {
      companyId: { type: "keyword" }, // routing
      projectId: { type: "keyword" },
      userId: { type: "keyword" }, // the uploader
      postId: { type: "keyword" },
      tags: { type: "keyword" },
      status: { type: "keyword" }, // ACTIVE/deleted filter
      fileType: { type: "keyword" }, // file-type filter + response
      note: { type: "text", fields: { keyword: { type: "keyword" } } }, // denormalized from parent Posts.note at index time
      createdAt: { type: "date" }, // date-range filter + primary sort
      timestamp: { type: "date" }, // dateTaken sort, falls back to createdAt
      position: { type: "integer" }, // sort tiebreaker / file order
      mongoUpdatedAt: { type: "date" },
    },
  },
};
