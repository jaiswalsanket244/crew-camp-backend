/**
 * Migrates the retired company-wide `projects.pinnedAt` field to per-user rows in `projectpins`.
 *
 * Existing pins carry no `pinnedBy`, so attribution is impossible. Per the migration decision,
 * each pinned project is inherited by that company's ADMIN / SUPERADMIN members.
 *
 * Usage:
 *   node scripts/migrateProjectPins.js                  # dry run — reports, writes nothing
 *   node scripts/migrateProjectPins.js --apply          # create the projectpins rows
 *   node scripts/migrateProjectPins.js --apply --unset-legacy
 *                                                       # also $unset projects.pinnedAt
 *
 * --unset-legacy is a SEPARATE phase on purpose: run it only once the per-user pins have been
 * verified in the app, so rolling back is just "drop the projectpins collection".
 *
 * Notes:
 *  - Idempotent. Pin rows are upserted on (userId, projectId), so re-running is safe.
 *  - The unset uses the RAW driver, not Mongoose, so it does not bump `updatedAt` — that field
 *    is the list's default sort key and bumping it would silently reorder migrated projects.
 *  - Respects MAX_PINS_PER_USER: an admin already at the cap is skipped and reported rather than
 *    pushed over it.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const MAX_PINS_PER_USER = 20;
const INHERITING_ROLES = ["ADMIN", "SUPERADMIN"];

const apply = process.argv.includes("--apply");
const unsetLegacy = process.argv.includes("--unset-legacy");

(async () => {
  const uri = process.env.DB_PATH;
  if (!uri) {
    throw new Error("DB_PATH is not set");
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`\ndatabase: ${db.databaseName}`);
  console.log(`mode:     ${apply ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`roles:    ${INHERITING_ROLES.join(", ")}\n`);

  const projects = db.collection("projects");
  const companyMembers = db.collection("companymembers");
  const projectPins = db.collection("projectpins");

  const pinned = await projects
    .find(
      { pinnedAt: { $exists: true, $ne: null } },
      { projection: { _id: 1, companyId: 1, name: 1, pinnedAt: 1 } },
    )
    .toArray();

  console.log(`legacy pinned projects: ${pinned.length}`);
  if (!pinned.length) {
    await mongoose.disconnect();
    return;
  }

  // Resolve inheriting members once per company rather than once per project.
  const companyIds = [
    ...new Set(
      pinned.filter((p) => p.companyId).map((p) => String(p.companyId)),
    ),
  ];
  const memberRows = await companyMembers
    .find(
      {
        companyId: {
          $in: companyIds.map((id) => new mongoose.Types.ObjectId(id)),
        },
        role: { $in: INHERITING_ROLES },
        status: "ACTIVE",
      },
      { projection: { companyId: 1, userId: 1 } },
    )
    .toArray();

  const adminsByCompany = new Map();
  memberRows.forEach((m) => {
    const key = String(m.companyId);
    if (!adminsByCompany.has(key)) adminsByCompany.set(key, []);
    adminsByCompany.get(key).push(m.userId);
  });

  // Existing per-user pin counts, so the cap is enforced against reality, not just this batch.
  const pinCounts = new Map();
  const countKey = (userId, companyId) => `${userId}:${companyId}`;
  const existing = await projectPins
    .find({}, { projection: { userId: 1, companyId: 1 } })
    .toArray();
  existing.forEach((row) => {
    const key = countKey(row.userId, row.companyId);
    pinCounts.set(key, (pinCounts.get(key) ?? 0) + 1);
  });

  const ops = [];
  const skippedNoAdmin = [];
  const skippedAtCap = [];

  for (const project of pinned) {
    if (!project.companyId) {
      skippedNoAdmin.push(`${project._id} (${project.name}) — no companyId`);
      continue;
    }
    const admins = adminsByCompany.get(String(project.companyId)) ?? [];
    if (!admins.length) {
      skippedNoAdmin.push(
        `${project._id} (${project.name}) — no active admins`,
      );
      continue;
    }
    for (const userId of admins) {
      const key = countKey(userId, project.companyId);
      if ((pinCounts.get(key) ?? 0) >= MAX_PINS_PER_USER) {
        skippedAtCap.push(`${userId} → ${project._id} (${project.name})`);
        continue;
      }
      pinCounts.set(key, (pinCounts.get(key) ?? 0) + 1);
      ops.push({
        updateOne: {
          filter: { userId, projectId: project._id },
          update: {
            $set: {
              userId,
              projectId: project._id,
              companyId: project.companyId,
              pinnedAt: project.pinnedAt,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      });
    }
  }

  console.log(`pin rows to create/update: ${ops.length}`);
  if (skippedNoAdmin.length) {
    console.log(`\nskipped (no inheriting admin): ${skippedNoAdmin.length}`);
    skippedNoAdmin.forEach((s) => console.log(`  - ${s}`));
  }
  if (skippedAtCap.length) {
    console.log(`\nskipped (user already at cap): ${skippedAtCap.length}`);
    skippedAtCap.forEach((s) => console.log(`  - ${s}`));
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    await mongoose.disconnect();
    return;
  }

  if (ops.length) {
    const result = await projectPins.bulkWrite(ops, { ordered: false });
    console.log(
      `\ninserted: ${result.upsertedCount}, updated: ${result.modifiedCount}`,
    );
  }

  // Indexes matching lib/db/projectPins.ts, in case the app has not started against this DB yet.
  await projectPins.createIndex({ userId: 1, projectId: 1 }, { unique: true });
  await projectPins.createIndex({
    userId: 1,
    companyId: 1,
    pinnedAt: -1,
    projectId: 1,
  });
  await projectPins.createIndex({ projectId: 1 });
  console.log("indexes ensured");

  if (unsetLegacy) {
    // Raw driver — deliberately NOT Mongoose, which would bump updatedAt on all of these.
    const unset = await projects.updateMany(
      { pinnedAt: { $exists: true } },
      { $unset: { pinnedAt: "" } },
    );
    console.log(
      `legacy projects.pinnedAt cleared on ${unset.modifiedCount} docs`,
    );
  } else {
    console.log(
      "\nlegacy projects.pinnedAt left in place — re-run with --unset-legacy once verified.",
    );
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
