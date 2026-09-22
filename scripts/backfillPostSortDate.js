// Backfill PostFiles.postSortDate (a post's anchor date = min createdAt of
// its files — the value GET /api/posts/uploads/v2 paginates on) and create
// the uploads-v2 compound indexes.
//
//   node scripts/backfillPostSortDate.js                        # backfill only
//   node scripts/backfillPostSortDate.js --start-after-id 65abc…  # resume from checkpoint
//   node scripts/backfillPostSortDate.js --batch-size 500         # posts per batch (default 1000)
//   node scripts/backfillPostSortDate.js --fill-orphans           # anchor files whose post is gone
//   node scripts/backfillPostSortDate.js --create-indexes         # build indexes (run AFTER backfill)
//
// Requires the COMPILED output in server/ (run `tsc` first). Connects to
// whatever DB_PATH is in .env — run against staging first and get explicit
// approval before pointing at production.
//
// Operational notes for very large collections (10^8-10^9 postfiles):
// - The backfill walks the posts collection by _id ascending and logs a
//   checkpoint after every batch; if interrupted, resume with
//   --start-after-id <last logged id>. Re-runs are idempotent (only docs
//   missing postSortDate are touched).
// - Build the indexes AFTER the backfill completes, off-peak: four index
//   builds on a collection this size take hours and compete for disk I/O.
//   Indexes are created here (not declared in the Mongoose schema) precisely
//   so a deploy can never trigger an accidental autoIndex build.

const parseFlagValue = (argv, name) => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}`) {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return "";
      return value.trim();
    }
    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(`--${name}=`.length).trim();
    }
  }
  return "";
};

const hasFlag = (argv, name) => argv.includes(`--${name}`);

// Sort keys can't be served by one index in both directions: postSortDate and
// postId flip between NEWEST and OLDEST while position stays ascending, so a
// reverse index walk never matches. Hence one index per direction per scope.
// If OLDEST traffic turns out to be negligible, the two *_oldest indexes can
// be skipped to halve the build time and disk cost.
const UPLOADS_V2_INDEXES = [
  {
    name: "uploads_v2_project_newest",
    keys: {
      projectId: 1,
      status: 1,
      postSortDate: -1,
      postId: -1,
      position: 1,
      _id: 1,
    },
  },
  {
    name: "uploads_v2_project_oldest",
    keys: {
      projectId: 1,
      status: 1,
      postSortDate: 1,
      postId: 1,
      position: 1,
      _id: 1,
    },
  },
  {
    name: "uploads_v2_company_newest",
    keys: {
      companyId: 1,
      status: 1,
      postSortDate: -1,
      postId: -1,
      position: 1,
      _id: 1,
    },
  },
  {
    name: "uploads_v2_company_oldest",
    keys: {
      companyId: 1,
      status: 1,
      postSortDate: 1,
      postId: 1,
      position: 1,
      _id: 1,
    },
  },
  // Scroll v2 timestamp sorts (DATE_TAKEN_*): unlike the pairs above, one
  // index serves both directions — every sort key flips together, so a
  // backward walk matches ASC exactly.
  {
    name: "uploads_v2_project_timestamp",
    keys: {
      projectId: 1,
      status: 1,
      timestamp: -1,
      createdAt: -1,
      _id: -1,
    },
  },
];

const backfill = async ({
  Posts,
  PostFiles,
  mongoose,
  startAfterId,
  batchSize,
}) => {
  let lastId = startAfterId ? new mongoose.Types.ObjectId(startAfterId) : null;
  let processedPosts = 0;
  let updatedFiles = 0;
  const startedAt = Date.now();

  for (;;) {
    const filter = lastId ? { _id: { $gt: lastId } } : {};
    const posts = await Posts.find(filter, { _id: 1 })
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();
    if (!posts.length) break;

    const postIds = posts.map((p) => p._id);
    // Anchor per post = min createdAt across its files, restricted to files
    // still missing postSortDate so re-runs skip finished posts cheaply.
    const groups = await PostFiles.aggregate([
      {
        $match: {
          postId: { $in: postIds },
          postSortDate: { $exists: false },
        },
      },
      { $group: { _id: "$postId", anchor: { $min: "$createdAt" } } },
    ]);

    if (groups.length) {
      const result = await PostFiles.bulkWrite(
        groups.map((g) => ({
          updateMany: {
            filter: { postId: g._id, postSortDate: { $exists: false } },
            update: {
              // Files with no createdAt at all fall back to the post id's
              // embedded timestamp.
              $set: { postSortDate: g.anchor || g._id.getTimestamp() },
            },
          },
        })),
        { ordered: false },
      );
      updatedFiles += result.modifiedCount || 0;
    }

    processedPosts += posts.length;
    lastId = posts[posts.length - 1]._id;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `checkpoint --start-after-id ${lastId} | posts ${processedPosts} | files updated ${updatedFiles} | ${elapsed}s`,
    );
  }

  console.log(
    `backfill done: ${processedPosts} posts scanned, ${updatedFiles} files updated`,
  );
};

// Files whose parent post no longer exists are never reached by the per-post
// walk; anchor them to their own createdAt so they can't linger unindexed.
const fillOrphans = async ({ PostFiles }) => {
  const result = await PostFiles.updateMany(
    { postSortDate: { $exists: false } },
    [{ $set: { postSortDate: { $ifNull: ["$createdAt", "$$NOW"] } } }],
  );
  console.log(`orphan fill done: ${result.modifiedCount} files updated`);
};

const createIndexes = async ({ PostFiles }) => {
  for (const { name, keys } of UPLOADS_V2_INDEXES) {
    console.log(`creating index ${name} …`);
    const t0 = Date.now();
    await PostFiles.collection.createIndex(keys, { name });
    console.log(`  ${name} done in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
};

const main = async () => {
  const argv = process.argv.slice(2);
  const startAfterId = parseFlagValue(argv, "start-after-id");
  const batchSizeRaw = parseInt(parseFlagValue(argv, "batch-size"), 10);
  const batchSize =
    Number.isInteger(batchSizeRaw) && batchSizeRaw > 0 ? batchSizeRaw : 1000;

  const { connectDB } = require("../server/services/connectDB");
  await connectDB();
  const { Posts, PostFiles } = require("../server/db");
  const mongoose = require("mongoose");

  if (hasFlag(argv, "create-indexes")) {
    await createIndexes({ PostFiles });
  } else if (hasFlag(argv, "fill-orphans")) {
    await fillOrphans({ PostFiles });
  } else {
    await backfill({ Posts, PostFiles, mongoose, startAfterId, batchSize });
  }

  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
