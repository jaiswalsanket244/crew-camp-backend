import { Likes } from "../../db";

type UpdateQueryType = {
  userId: string;
  noteId?: string;
  commentId?: string;
};
export class LikesHelper {
  public static like = async (
    query: { commentId?: string; noteId?: string },
    userId: string,
    isLiked,
  ) => {
    const updateQuery: UpdateQueryType = { userId };
    if (query.noteId) {
      updateQuery.noteId = query.noteId;
    } else {
      updateQuery.commentId = query.commentId;
    }

    return Likes.findOneAndUpdate(
      updateQuery,
      {
        $set: {
          isLiked,
        },
      },
      {
        upsert: true,
      },
    );
  };
}
