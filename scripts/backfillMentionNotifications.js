// Repair MENTION notifications (and comment mention arrays) created before
// two client fixes shipped on 2026-08-14:
//
// 1. URL anchor: web-created file comments never sent currentIndex, so their
//    notification URLs lack a file anchor and deep-link to the post's first
//    file. The comment doc still holds the fileId it was made on, so we
//    append `&fileId=<id>` — both clients anchor by fileId.
// 2. Recipient remap: web mentions used the CompanyMember _id instead of the
//    user's _id, so those notifications point at a non-existent user and are
//    invisible. Remap notification.userId (and Comments.mentions entries)
//    via CompanyMembers._id -> userId.
//
//   node scripts/backfillMentionNotifications.js            # dry-run (no writes)
//   node scripts/backfillMentionNotifications.js --apply    # perform the writes
//
// Requires the COMPILED output in server/ (run `tsc` first). Connects to
// whatever DB_PATH is in .env — run against staging first and get explicit
// approval before pointing at production. Re-runs are idempotent: URL fixes
// skip notifications that already have fileId=, remaps only match ids that
// exist in CompanyMembers and not in Users.

const hasFlag = (argv, name) => argv.includes(`--${name}`);

const BATCH = 500;

// notification.userId values that are CompanyMember ids can never collide
// with real User ids, but check both collections anyway: only remap an id
// that is NOT a user and IS a company member.
const buildRemap = async ({ User, CompanyMember, candidateIds }) => {
  const ids = [...candidateIds];
  if (!ids.length) return new Map();

  const [users, members] = await Promise.all([
    User.find({ _id: { $in: ids } }, { _id: 1 }).lean(),
    CompanyMember.find({ _id: { $in: ids } }, { _id: 1, userId: 1 }).lean(),
  ]);
  const realUserIds = new Set(users.map((u) => u._id.toString()));

  const remap = new Map();
  for (const m of members) {
    const key = m._id.toString();
    if (!realUserIds.has(key) && m.userId) {
      remap.set(key, m.userId);
    }
  }
  return remap;
};

const fixNotificationUrls = async ({ Notification, Comments, apply }) => {
  // Post-comment mention URLs missing a file anchor entirely.
  const filter = {
    category: "MENTION",
    url: { $regex: "postId=", $options: "" },
    $and: [
      { url: { $regex: "commentId=" } },
      { url: { $not: { $regex: "fileId=" } } },
      { url: { $not: { $regex: "currentIndex=" } } },
    ],
  };

  let scanned = 0;
  let fixable = 0;
  let updated = 0;
  let lastId = null;

  for (;;) {
    const pageFilter = lastId ? { ...filter, _id: { $gt: lastId } } : filter;
    const batch = await Notification.find(pageFilter, { _id: 1, url: 1 })
      .sort({ _id: 1 })
      .limit(BATCH)
      .lean();
    if (!batch.length) break;
    scanned += batch.length;
    lastId = batch[batch.length - 1]._id;

    const commentIdOf = (url) => {
      const match = /[?&]commentId=([a-f0-9]{24})/i.exec(url || "");
      return match ? match[1] : null;
    };

    const commentIds = [
      ...new Set(batch.map((n) => commentIdOf(n.url)).filter(Boolean)),
    ];
    const comments = await Comments.find(
      { _id: { $in: commentIds }, fileId: { $exists: true, $ne: null } },
      { _id: 1, fileId: 1 },
    ).lean();
    const fileIdByComment = new Map(
      comments.map((c) => [c._id.toString(), c.fileId.toString()]),
    );

    const ops = [];
    for (const n of batch) {
      const commentId = commentIdOf(n.url);
      const fileId = commentId && fileIdByComment.get(commentId);
      if (!fileId) continue;
      fixable += 1;
      ops.push({
        updateOne: {
          filter: { _id: n._id },
          update: { $set: { url: `${n.url}&fileId=${fileId}` } },
        },
      });
    }

    if (apply && ops.length) {
      const result = await Notification.bulkWrite(ops, { ordered: false });
      updated += result.modifiedCount || 0;
    }
    console.log(
      `url-fix checkpoint ${lastId} | scanned ${scanned} | fixable ${fixable} | updated ${updated}`,
    );
  }

  console.log(
    `url-fix done: ${scanned} scanned, ${fixable} fixable, ${
      apply ? updated : 0
    } updated${apply ? "" : " (dry-run)"}`,
  );
};

const remapNotificationRecipients = async ({
  Notification,
  User,
  CompanyMember,
  apply,
}) => {
  const candidateIds = await Notification.distinct("userId", {
    category: "MENTION",
  });
  const remap = await buildRemap({
    User,
    CompanyMember,
    candidateIds: candidateIds.map((id) => id.toString()),
  });

  if (!remap.size) {
    console.log("recipient-remap done: no CompanyMember ids found");
    return;
  }

  let updated = 0;
  for (const [memberId, userId] of remap) {
    const filter = { category: "MENTION", userId: memberId };
    if (apply) {
      const result = await Notification.updateMany(filter, {
        $set: { userId },
      });
      updated += result.modifiedCount || 0;
    } else {
      updated += await Notification.countDocuments(filter);
    }
    console.log(`  remap ${memberId} -> ${userId}`);
  }
  console.log(
    `recipient-remap done: ${remap.size} member ids, ${updated} notifications ${
      apply ? "updated" : "affected (dry-run)"
    }`,
  );
};

const remapCommentMentions = async ({
  Comments,
  User,
  CompanyMember,
  apply,
}) => {
  const candidateIds = await Comments.distinct("mentions", {
    mentions: { $exists: true, $ne: [] },
  });
  const remap = await buildRemap({
    User,
    CompanyMember,
    candidateIds: candidateIds.map((id) => id.toString()),
  });

  if (!remap.size) {
    console.log("comment-mentions done: no CompanyMember ids found");
    return;
  }

  let updated = 0;
  for (const [memberId, userId] of remap) {
    const filter = { mentions: memberId };
    if (apply) {
      // $set via arrayFilters keeps order and other entries; dedupe is not
      // needed — a comment can't legitimately mention the same user twice
      // through two different membership records of one company.
      const result = await Comments.updateMany(
        filter,
        { $set: { "mentions.$[el]": userId } },
        { arrayFilters: [{ el: memberId }] },
      );
      updated += result.modifiedCount || 0;
    } else {
      updated += await Comments.countDocuments(filter);
    }
    console.log(`  remap ${memberId} -> ${userId}`);
  }
  console.log(
    `comment-mentions done: ${remap.size} member ids, ${updated} comments ${
      apply ? "updated" : "affected (dry-run)"
    }`,
  );
};

const main = async () => {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");

  const { connectDB } = require("../server/services/connectDB");
  await connectDB();
  const mongoose = require("mongoose");
  const {
    Notification,
    Comments,
    CompanyMember,
    User,
  } = require("../server/db");

  const { host, name } = mongoose.connection;
  console.log(
    `connected to ${host}/${name} — mode: ${apply ? "APPLY" : "dry-run"}`,
  );

  await fixNotificationUrls({ Notification, Comments, apply });
  await remapNotificationRecipients({
    Notification,
    User,
    CompanyMember,
    apply,
  });
  await remapCommentMentions({ Comments, User, CompanyMember, apply });

  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
