// CLI wrapper: deploy a search index mapping from code.
//
//   node scripts/deploySearchMapping.js --mapping projects-v1
//   node scripts/deploySearchMapping.js --mapping=posts_uploads-v1
//
// Requires the COMPILED output in server/ (run `tsc` first). The transitive
// config import loads .env via its own dotenv.config(), so no env wiring here.
// This wrapper never imports @opensearch-project/opensearch directly — the
// opensearch boundary stays inside lib/search/.

const USAGE =
  "Usage: node scripts/deploySearchMapping.js --mapping <projects-v1|posts_uploads-v1>";

// Returns the trimmed mapping name, or "" when --mapping is absent, empty, or
// followed by another flag. Supports both `--mapping <name>` and `--mapping=<name>`.
const parseMapping = (argv) => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mapping") {
      const value = argv[i + 1];
      // Missing value, or the next token is another flag (e.g. `--mapping --x`).
      if (!value || value.startsWith("-")) {
        return "";
      }
      return value.trim();
    }
    if (arg.startsWith("--mapping=")) {
      return arg.slice("--mapping=".length).trim();
    }
  }
  return "";
};

const main = async () => {
  const mappingName = parseMapping(process.argv.slice(2));
  if (!mappingName) {
    console.error(USAGE);
    process.exit(1);
  }

  const { deployMapping } = require("../server/search/cli/deployMapping");
  await deployMapping(mappingName);
};

// Only run when invoked directly (node scripts/...). When require()'d by a test,
// this is skipped so parseMapping can be exercised without side effects.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { parseMapping };
