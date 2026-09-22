import { PostFiles } from "../../db";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { SearchClientService } from "../searchClient";
import { toStr } from "../reindex/projectSearchDoc";

const PROJECTS_ALIAS = "projects";

// Atomic painless: prepend the new entry, dedupe by postId, sort by createdAt (ISO
// string) desc, truncate to 5. Self-no-ops when the post doesn't crack the top-5 (it
// gets dropped by the truncate). String == is reference-equality in painless, so
// compare with .equals; createdAt is an ISO string so compareTo is chronological.
const RECENT_POSTS_SCRIPT = [
  "if (ctx._source.recentPosts == null) { ctx._source.recentPosts = new ArrayList(); }",
  "ctx._source.recentPosts.removeIf(p -> params.entry.postId.equals(p.postId));",
  "ctx._source.recentPosts.add(params.entry);",
  "ctx._source.recentPosts.sort((a, b) -> b.createdAt == null ? -1 : (a.createdAt == null ? 1 : b.createdAt.compareTo(a.createdAt)));",
  "if (ctx._source.recentPosts.size() > 5) {",
  "  ctx._source.recentPosts = new ArrayList(ctx._source.recentPosts.subList(0, 5));",
  "}",
].join("\n");

interface RecentPostInput {
  _id: ObjectIdType;
  projectId: ObjectIdType;
  companyId: ObjectIdType;
  createdAt?: Date;
}

// On a new post, conditionally refresh its parent project's `recentPosts` top-5 array (high-frequency). Builds the entry with the post's ACTIVE files (parity with the backfill recentPosts shape — usually empty at insert time) and issues a single atomic partial-update; the painless script decides whether the post cracks the top-5. Routing = companyId; retry_on_conflict handles concurrent posts.
export const recentPostsHelper = async (
  post: RecentPostInput,
): Promise<void> => {
  const files = await PostFiles.find({
    postId: post._id,
    status: CURRENT_STATUS.ACTIVE,
  })
    .sort({ position: 1, createdAt: 1 })
    .lean();

  const entry = {
    postId: toStr(post._id),
    createdAt: post.createdAt ? new Date(post.createdAt).toISOString() : "",
    files,
  };

  await SearchClientService.getInstance().update({
    index: PROJECTS_ALIAS,
    id: toStr(post.projectId),
    routing: toStr(post.companyId),
    retry_on_conflict: 3,
    body: {
      script: {
        lang: "painless",
        source: RECENT_POSTS_SCRIPT,
        params: { entry },
      },
    },
  });
};
