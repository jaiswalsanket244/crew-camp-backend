// Manual Salesforce lead re-sync for a slice of accounts, usually one picked by
// createdAt — e.g. signups from a window where lead creation failed (Salesforce
// down, token expired, a bad deploy) and whose users never got a
// salesforceLeadId stamped on them.
//
//   node scripts/resyncSalesforceLeads.js --created-on 2026-09-08              # DRY RUN (default)
//   node scripts/resyncSalesforceLeads.js --created-on 2026-09-08 --apply      # resolve/create leads + push snapshot
//   node scripts/resyncSalesforceLeads.js --created-after 2026-09-01 --created-before 2026-09-09 --apply
//   node scripts/resyncSalesforceLeads.js --created-on 2026-09-08 --leads-only --apply   # leads only, no usage push
//   node scripts/resyncSalesforceLeads.js --company-id 65abc...,65def... --apply
//   node scripts/resyncSalesforceLeads.js --email a@b.com --apply              # admin's company
//   node scripts/resyncSalesforceLeads.js --created-on 2026-09-08 --missing-only --apply
//   node scripts/resyncSalesforceLeads.js --created-on 2026-09-08 --limit 25
//
// Requires the COMPILED output in server/ (run `tsc` first). Connects to whatever
// DB_PATH is in .env and talks to whatever Salesforce org the config points at —
// run against staging first and get explicit approval before pointing at prod.
//
// This is the same code path as the nightly cron (SalesforceAccountSyncService),
// just scoped to selected companies: leads are matched on email, or on an
// existing Contact, or created; the resolved Id is persisted to the admin user so
// re-runs cost no Salesforce calls. Idempotent — safe to re-run on the same slice.
//
// Selection is company-scoped because that's the unit the sync works on, and a
// company is created in the same request as its admin, so a createdAt window over
// companies is the same window over admin signups. All dates are parsed as UTC.
// At least one selector is required: a bare run would re-sync every account,
// which is the nightly cron's job.

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

const parseList = (raw) =>
  raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const parsePositiveInt = (raw, fallback) => {
  const value = parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

// Bare `YYYY-MM-DD` is read as UTC midnight (what `new Date()` already does for
// that form); anything else falls through to normal ISO parsing.
const parseDate = (raw, label) => {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `invalid --${label} date: "${raw}" (use ISO, e.g. 2026-09-08)`,
    );
  }
  return date;
};

// `--created-on <day>` is the common case: the whole UTC day as [start, next day).
const dayRange = (raw) => {
  const start = parseDate(raw, "created-on");
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};

const buildCompanyFilter = async ({
  User,
  mongoose,
  CURRENT_STATUS,
  createdAfter,
  createdBefore,
  companyIds,
  emails,
}) => {
  const filter = { status: CURRENT_STATUS.ACTIVE };

  if (createdAfter || createdBefore) {
    filter.createdAt = {};
    if (createdAfter) filter.createdAt.$gte = createdAfter;
  }

  if (companyIds.length) {
    filter._id = {
      $in: companyIds.map((id) => new mongoose.Types.ObjectId(id)),
    };
  }

  // An email selects the company (or companies) that user administers, which is
  // how support requests usually arrive — "resync this customer".
  if (emails.length) {
    const users = await User.find(
      { email: { $in: emails.map((email) => email.toLowerCase()) } },
      { _id: 1 },
    ).lean();
    const adminIds = users.map((user) => user._id);
    filter.userId = { $in: adminIds };
    console.log(`--email matched ${adminIds.length} user(s)`);
  }

  return filter;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");
  const leadsOnly = hasFlag(argv, "leads-only");
  const missingOnly = hasFlag(argv, "missing-only");
  const limit = parsePositiveInt(parseFlagValue(argv, "limit"), 0);
  const companyIds = parseList(parseFlagValue(argv, "company-id"));
  const emails = parseList(parseFlagValue(argv, "email"));

  const createdOn = parseFlagValue(argv, "created-on");
  let createdAfter = parseDate(
    parseFlagValue(argv, "created-after"),
    "created-after",
  );
  let createdBefore = parseDate(
    parseFlagValue(argv, "created-before"),
    "created-before",
  );
  if (createdOn) {
    const range = dayRange(createdOn);
    createdAfter = range.start;
    createdBefore = range.end;
  }

  if (!createdAfter && !createdBefore && !companyIds.length && !emails.length) {
    console.error(
      "refusing to run unscoped: pass --created-on / --created-after / --created-before, --company-id, or --email",
    );
    process.exit(1);
  }

  const { config } = require("../server/utils/configuration/config");
  // Host only — never print the credentials embedded in DB_PATH.
  const target = String(config.DB_PATH || "").replace(/^.*@/, "");
  console.log(`target DB: ${target}`);
  console.log(`salesforce: ${config.SALESFORCE_INSTANCE_URL || "(unset)"}`);
  console.log(apply ? "mode: APPLY (writes enabled)" : "mode: DRY RUN");
  console.log(
    leadsOnly
      ? "scope: leads only (resolve/create, no usage snapshot push)"
      : "scope: leads + usage snapshot push",
  );
  if (createdAfter || createdBefore) {
    console.log(
      `createdAt: ${createdAfter ? createdAfter.toISOString() : "-inf"} -> ${
        createdBefore ? createdBefore.toISOString() : "+inf"
      }`,
    );
  }
  console.log("");

  const { connectDB } = require("../server/services/connectDB");
  await connectDB();

  const { Company, User } = require("../server/db");
  const { CURRENT_STATUS } = require("../server/utils/enums/enums");
  const {
    SalesforceAccountSyncService,
  } = require("../server/services/salesforceAccountSync");
  const mongoose = require("mongoose");

  const filter = await buildCompanyFilter({
    User,
    mongoose,
    CURRENT_STATUS,
    createdAfter,
    createdBefore,
    companyIds,
    emails,
  });

  console.log("company filter:", filter);
  let query = Company.find(filter, { name: 1, userId: 1, createdAt: 1 }).sort({
    createdAt: 1,
  });
  if (limit) query = query.limit(limit);
  let companies = await query.lean();

  if (!companies.length) {
    console.log("no active companies matched the selection — nothing to do");
    process.exit(0);
  }

  // Admin lead state drives both the dry-run report and --missing-only, so it's
  // fetched once for every selected company's admin.
  const admins = await User.find(
    {
      _id: { $in: companies.map((company) => company.userId).filter(Boolean) },
    },
    { email: 1, name: 1, salesforceLeadId: 1, salesforceContactId: 1 },
  ).lean();
  const adminById = new Map(admins.map((admin) => [String(admin._id), admin]));

  if (missingOnly) {
    companies = companies.filter((company) => {
      const admin = adminById.get(String(company.userId));
      return admin && !admin.salesforceLeadId && !admin.salesforceContactId;
    });
    if (!companies.length) {
      console.log(
        "every selected admin already has a lead/contact id — nothing to do",
      );
      process.exit(0);
    }
  }

  let linked = 0;
  console.log(`selected ${companies.length} compan(ies):`);
  for (const company of companies) {
    const admin = adminById.get(String(company.userId));
    const leadId = admin?.salesforceLeadId || admin?.salesforceContactId || "";
    if (leadId) linked += 1;
    console.log(
      `  ${String(company._id)}  ${company.createdAt ? new Date(company.createdAt).toISOString() : "?"}  ${
        company.name || "(no name)"
      }  ${admin?.email || "(no admin email)"}  ${leadId ? `lead/contact ${leadId}` : "NO LEAD"}`,
    );
  }
  console.log(
    `\n${linked} already linked, ${companies.length - linked} missing a lead/contact id`,
  );

  if (!apply) {
    console.log("\nDRY RUN — re-run with --apply to sync these to Salesforce");
    process.exit(0);
  }

  const ids = companies.map((company) => company._id);

  if (leadsOnly) {
    const snapshots =
      await SalesforceAccountSyncService.buildAccountSnapshots(ids);
    const resolution =
      await SalesforceAccountSyncService.resolveMissingLeadIds(snapshots);
    console.log("\nlead resolution:", JSON.stringify(resolution, null, 2));
  } else {
    const { resolution, push } =
      await SalesforceAccountSyncService.runDailySync(ids);
    console.log("\nlead resolution:", JSON.stringify(resolution, null, 2));
    console.log("snapshot push:", JSON.stringify(push, null, 2));
  }

  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
