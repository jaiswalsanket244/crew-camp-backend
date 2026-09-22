// CLI wrapper: backfill the projects-v1 search index from MongoDB.
//
//   node scripts/backfillProjects.js                      # all companies
//   node scripts/backfillProjects.js --company-id 65abc...  # one company
//   node scripts/backfillProjects.js --company-id=65abc...  # equals form
//
// Requires the COMPILED output in server/ (run `tsc` first). Unlike the deploy CLI,
// this reads Mongo AND writes OpenSearch, so it connects to Mongo first. `config`
// loads .env via its own dotenv.config(). This wrapper never imports the
// opensearch package directly — the boundary stays inside lib/search/.

// Returns the trimmed company id, or "" when --company-id is absent, empty, or
// followed by another flag. Supports `--company-id <id>` and `--company-id=<id>`.
const parseCompanyId = (argv) => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--company-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        return "";
      }
      return value.trim();
    }
    if (arg.startsWith("--company-id=")) {
      return arg.slice("--company-id=".length).trim();
    }
  }
  return "";
};

// Positive integer batch size from `--batch-size <n>`/`=<n>`, else undefined (impl default) — lets operators throttle bulk size without a code change.
const parseBatchSize = (argv) => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--batch-size") {
      const n = parseInt(argv[i + 1], 10);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
    if (arg.startsWith("--batch-size=")) {
      const n = parseInt(arg.slice("--batch-size=".length), 10);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
  }
  return undefined;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const companyId = parseCompanyId(argv);
  const batchSize = parseBatchSize(argv);

  // Connect to Mongo before requiring the backfill (which queries models on call).
  const { connectDB } = require("../server/services/connectDB");
  await connectDB();

  const {
    backfillProjects,
  } = require("../server/search/reindex/backfillProjects");
  const opts = {};
  if (companyId) opts.companyId = companyId;
  if (batchSize) opts.batchSize = batchSize;
  const result = await backfillProjects(opts);

  const scope = companyId ? `company ${companyId}` : "all companies";
  console.log(
    `Backfilled ${result.documentsIndexed} projects into ${result.index} for ${scope} ` +
      `(${result.companiesProcessed} companies, ${result.companiesSkipped} skipped, ${result.failures} failures)`,
  );
  return result;
};

if (require.main === module) {
  main()
    // Exit non-zero when any document failed to index, so operators/CI notice
    // (a clean run that rejected every doc must NOT report success).
    .then((result) => process.exit(result && result.failures > 0 ? 1 : 0))
    .catch((err) => {
      // Surface OpenSearch ResponseError detail (status + body); else fall back to the stack.
      if (err && err.meta) {
        console.error("backfill failed", {
          message: err.message,
          statusCode: err.meta.statusCode,
          body: err.meta.body,
        });
      } else {
        console.error((err && err.stack) || err);
      }
      process.exit(1);
    });
}

module.exports = { parseCompanyId, parseBatchSize };
