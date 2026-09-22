// CLI wrapper: atomically swap a search alias to a new versioned index.
//
//   node scripts/aliasSwap.js --alias projects --from null --to projects-v1   # first-time
//   node scripts/aliasSwap.js --alias projects --from projects-v1 --to projects-v2
//
// Requires the COMPILED output in server/ (run `tsc` first). OpenSearch only — no
// Mongo connection. `config` loads .env via its own dotenv.config(). Never imports
// the opensearch package directly — the boundary stays inside lib/search/.

const USAGE =
  "Usage: node scripts/aliasSwap.js --alias <name> --to <index> [--from <index|null>]";

// Returns the trimmed value for `--<flag> <value>` or `--<flag>=<value>`, or ""
// when absent / empty / followed by another flag.
const parseFlag = (argv, flag) => {
  const eq = `--${flag}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${flag}`) {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        return "";
      }
      return value.trim();
    }
    if (arg.startsWith(eq)) {
      return arg.slice(eq.length).trim();
    }
  }
  return "";
};

const main = async () => {
  const argv = process.argv.slice(2);
  const alias = parseFlag(argv, "alias");
  const to = parseFlag(argv, "to");
  const fromRaw = parseFlag(argv, "from");
  // First-time deployment: --from null (or absent) → JS null (add-only).
  const from = !fromRaw || fromRaw === "null" ? null : fromRaw;

  if (!alias || !to) {
    console.error(USAGE);
    process.exit(1);
  }

  const { swapAlias } = require("../server/search/reindex/aliasSwap");
  await swapAlias(alias, from, to);
  console.log(`✅ Alias ${alias} → ${to}${from ? ` (was ${from})` : ""}`);
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { parseFlag };
