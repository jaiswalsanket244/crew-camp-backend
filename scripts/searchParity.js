// CLI wrapper: ES↔Mongo parity + latency runner.
//
//   node scripts/searchParity.js --company-id 65xxx [--route projects.list|posts.uploads|all]
//
// Requires the COMPILED output in server/ (run `tsc` first). Connects to Mongo (the runner invokes
// the real handlers, which hit the DB) and the OpenSearch cluster (env via config). Prints a speed
// table (ES vs Mongo latency per fixture + p50/p95/max) ALWAYS, plus parity pass/fail. Exits 0 if all
// fixtures pass, 1 if any fail or error. Operator-invoked — the only way to exercise the ES path
// while the flag stub is off (it forces the path via searchWithFallback). This wrapper never imports
// @opensearch-project/opensearch directly — that boundary stays inside lib/search/.

const USAGE =
  "Usage: node scripts/searchParity.js --company-id <id> [--route projects.list|posts.uploads|all]";

const VALID_ROUTES = ["projects.list", "posts.uploads", "all"];

// Returns argv[i+1] unless it's missing or itself a flag (so `--company-id --route x` doesn't
// swallow the next flag as the value).
const nextVal = (argv, i) => {
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v.trim() : "";
};

const parseArgs = (argv) => {
  const out = { companyId: "", route: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company-id") {
      out.companyId = nextVal(argv, i);
    } else if (a.startsWith("--company-id=")) {
      out.companyId = a.slice("--company-id=".length).trim();
    } else if (a === "--route") {
      out.route = nextVal(argv, i) || "all";
    } else if (a.startsWith("--route=")) {
      out.route = a.slice("--route=".length).trim();
    }
  }
  return out;
};

const fmt = (n) =>
  n === null || n === undefined ? "    -" : `${n}ms`.padStart(7);

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.companyId) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!VALID_ROUTES.includes(args.route)) {
    console.error(
      `Invalid --route "${args.route}". Use one of: ${VALID_ROUTES.join(" | ")}`,
    );
    process.exit(1);
  }

  // Connect to Mongo before invoking the handlers (which run real DB queries).
  const { connectDB } = require("../server/services/connectDB");
  await connectDB();

  const { runParity } = require("../server/search/cli/searchParity");
  const report = await runParity({
    companyId: args.companyId,
    route: args.route,
  });

  // Speed table (always) — the staging ES speed signal.
  console.log(
    `\nES↔Mongo parity + latency — company ${report.companyId} — route ${report.route}\n`,
  );
  console.log("STATUS  ES        MONGO     FIXTURE");
  report.details.forEach((d) => {
    const tag =
      d.status === "pass" ? "PASS " : d.status === "fail" ? "FAIL " : "ERROR";
    const note = d.esRanMongo ? "  (ES routed→Mongo)" : "";
    console.log(
      `${tag}  ${fmt(d.esLatencyMs)}   ${fmt(d.mongoLatencyMs)}   ${d.fixtureName}${note}`,
    );
  });
  console.log(
    `\nES latency    p50 ${report.esLatency.p50}ms  p95 ${report.esLatency.p95}ms  max ${report.esLatency.max}ms`,
  );
  console.log(
    `Mongo latency p50 ${report.mongoLatency.p50}ms  p95 ${report.mongoLatency.p95}ms  max ${report.mongoLatency.max}ms`,
  );
  console.log(
    `\nParity: ${report.passed} passed / ${report.failed} failed / ${report.errored} errored (of ${report.fixtureCount} fixtures)`,
  );
  const producedResults = report.details.some(
    (d) => d.resultCount && (d.resultCount.es > 0 || d.resultCount.mongo > 0),
  );
  if (report.fixtureCount === 0) {
    console.error(
      "\n⚠️  No fixtures matched the requested route — nothing tested.",
    );
  } else if (!producedResults) {
    console.error(
      "\n⚠️  No fixture produced any results (all empty) — check that the ES indexes are backfilled for this company and that --company-id is correct. Treating as a failed run.",
    );
  }

  // Detail on failures/errors (terse on pass).
  report.details
    .filter((d) => d.status !== "pass")
    .forEach((d) => {
      console.log(`\n[${d.status.toUpperCase()}] ${d.fixtureName}`);
      if (d.error) {
        console.log(`  error: ${d.error}`);
      }
      if (d.diff) {
        console.log(`  ${JSON.stringify(d.diff).slice(0, 600)}`);
      }
    });

  // Don't exit 0 on a vacuous run (0 fixtures / all-empty results) — that would read as a false green.
  const cleanRun =
    report.failed + report.errored === 0 &&
    report.fixtureCount > 0 &&
    producedResults;
  process.exit(cleanRun ? 0 : 1);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { parseArgs };
