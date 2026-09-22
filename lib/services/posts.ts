import { Comments, Posts, DeletedPostFiles, PostFiles } from "../db";
import { TRASHBIN_NO_OF_DAYS } from "../utils/constants/constants";
import { CURRENT_STATUS } from "../utils/enums/enums";
import { removeDays } from "../utils/helpers/commonHelper";
import { fileService } from "./awsBucket";

export class PostService {
  // A trashed file's images: the current one plus the retained pre-edit
  // original that backs "revert to original".
  private static deleteFileDataFromS3 = async (fileData: {
    url?: string;
    originalFileUrl?: string;
  }) => {
    const urls = [fileData?.url, fileData?.originalFileUrl].filter(
      (url): url is string => !!url,
    );
    await Promise.all(
      urls.map((url) => fileService.deleteFromS3UsingLink(url)),
    );
  };

  static deletePostData = async (post) => {
    const [comments, postFiles] = await Promise.all([
      Comments.find({
        postId: post._id,
        fileUrl: { $exists: true },
      }),
      PostFiles.find({ postId: post._id }, { url: 1, originalFileUrl: 1 }),
    ]);

    const filesInComments = comments.map((comment) => comment.fileUrl);

    // Edited files also hold their retained pre-edit image (the revert target),
    // which becomes unreferenced along with the file itself.
    const fileUrls = postFiles.flatMap((file) =>
      [file.url, file.originalFileUrl].filter((url): url is string => !!url),
    );

    await Promise.all([
      ...filesInComments.map((file) => fileService.deleteFromS3UsingLink(file)),
      Comments.deleteMany({
        postId: post._id,
      }),
      ...fileUrls.map((url) => fileService.deleteFromS3UsingLink(url)),
      PostFiles.deleteMany({ postId: post._id }),
    ]);
  };

  static async deletePostsInBin() {
    try {
      const daysAgo = removeDays(new Date(), TRASHBIN_NO_OF_DAYS);
      const query = {
        updatedAt: { $lt: daysAgo },
        status: CURRENT_STATUS.DELETED,
      };
      const posts = await Posts.find(query);

      await Promise.all(
        posts.map(async (post) => {
          await PostService.deletePostData(post);
        }),
      );

      await Posts.deleteMany(query);
    } catch {
      /* empty */
    }
  }

  static async deletePostsById(postId) {
    try {
      const post = await Posts.findById(postId);

      await PostService.deletePostData(post);

      await Posts.findByIdAndDelete(postId);
    } catch {
      /* empty */
    }
  }

  static async deletePostFileById(deletedFileId) {
    try {
      const deletedFile = await DeletedPostFiles.findById(deletedFileId);
      if (!deletedFile) return;

      // Delete from S3 (including the retained pre-edit original, if any)
      await PostService.deleteFileDataFromS3(deletedFile.fileData);

      // Delete comments associated with this file
      await Comments.deleteMany({ fileId: deletedFile.fileId });

      // Remove from DeletedPostFiles collection
      await DeletedPostFiles.findByIdAndDelete(deletedFileId);
    } catch {
      /* empty */
    }
  }

  public static permanentlyDeleteExpiredPostFiles = async () => {
    try {
      const daysAgo = removeDays(new Date(), TRASHBIN_NO_OF_DAYS);

      const expiredFiles = await DeletedPostFiles.find({
        deletedAt: { $lte: daysAgo },
      });

      for (const deletedFile of expiredFiles) {
        // Delete from S3 (including the retained pre-edit original, if any)
        await PostService.deleteFileDataFromS3(deletedFile.fileData);

        // Delete comments associated with this file
        await Comments.deleteOne({
          fileId: deletedFile.fileId,
        });

        // Remove from DeletedPostFiles collection
        await DeletedPostFiles.findByIdAndDelete(deletedFile._id);
      }
    } catch {
      /* empty */
    }
  };
}
