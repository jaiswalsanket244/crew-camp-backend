import { SearchResumeToken } from "../../db";

// The opaque BSON resume-token blob (Mongo change-stream `{ _data, ... }`).
export type ResumeToken = Record<string, unknown>;

// Returns the persisted token for a consumer, or null for a fresh start (open the change stream from "now"). Read-lean.
export const getResumeToken = async (
  consumerKey: string,
): Promise<ResumeToken | null> => {
  const doc = await SearchResumeToken.findOne({ consumerKey }).lean();
  return (doc?.resumeToken as ResumeToken) ?? null;
};

// Upserts the token. AWAIT this before ACKing a batch — never fire-and-forget; the at-least-once guarantee depends on the token being durable first. $set (not doc.save) overwrites the Mixed path cleanly without markModified.
export const saveResumeToken = async (
  consumerKey: string,
  token: ResumeToken,
): Promise<void> => {
  await SearchResumeToken.updateOne(
    { consumerKey },
    { $set: { resumeToken: token } },
    { upsert: true },
  );
};
