// CLI debug tool: print the ES document for a Mongo _id.
//
//   node scripts/inspectSearchDoc.js --index projects --id 65xxx --routing <companyId>
//
// NOTE: projects / posts_uploads are routed by companyId — pass --routing <companyId>
// or a present doc will report "not found" (wrong shard). Requires the COMPILED
// output in server/ (run `tsc` first). OpenSearch only — no Mongo connection.
// Never imports the opensearch package directly.

const USAGE =
  "Usage: node scripts/inspectSearchDoc.js --index <index> --id <id> [--routing <companyId>]";

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
  const index = parseFlag(argv, "index");
  const id = parseFlag(argv, "id");
  const routing = parseFlag(argv, "routing");

  if (!index || !id) {
    console.error(USAGE);
    process.exit(1);
  }

  const { inspectDocument } = require("../server/search/cli/inspectDocument");
  const doc = await inspectDocument(index, id, routing || undefined);

  if (!doc) {
    console.log(`Document not found in ES index \`${index}\``);
    return;
  }
  console.log(JSON.stringify(doc, null, 2));
  console.log(
    `mongoUpdatedAt: ${doc.mongoUpdatedAt}; companyId: ${doc.companyId}`,
  );
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
