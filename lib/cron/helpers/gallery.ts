import { Gallery, GalleryFiles } from "../../db";
import { fileService } from "../../services/awsBucket";
import { removeDays } from "../../utils/helpers/commonHelper";

export class GalleriesCronHelper {
  public static async deleteOldGallaries() {
    try {
      const daysAgo = removeDays(new Date(), 365);

      const galleries = await Gallery.find(
        { createdAt: { $lt: daysAgo } },
        { _id: 1 },
      );

      const galleryIds = galleries.map((gallery) => gallery._id);

      const galleryFiles = await GalleryFiles.find({
        galleryId: { $in: galleryIds },
        postId: { $exists: false },
      });

      const fileUrls = [];

      galleryFiles.forEach((galleryFile) => {
        galleryFile.files.forEach((file) => {
          fileUrls.push(file.url);
        });
      });

      await Promise.all([
        fileUrls.map((file) => fileService.deleteFromS3UsingLink(file)),
        GalleryFiles.deleteMany({
          galleryId: { $in: galleryIds },
        }),
        Gallery.deleteMany({ galleryId: { $in: galleryIds } }),
      ]);
    } catch {
      /* empty */
    }
  }
}
