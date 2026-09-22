import { Files } from "../db";
import { TRASHBIN_NO_OF_DAYS } from "../utils/constants/constants";
import { CURRENT_STATUS } from "../utils/enums/enums";
import { removeDays } from "../utils/helpers/commonHelper";
import { ObjectIdType } from "../utils/interfaces/schemaInterface";
import { fileService } from "./awsBucket";

export class FilesService {
  static deleteFileById = async (fileId: ObjectIdType) => {
    try {
      const file = await Files.findById(fileId, { url: 1 });
      if (!file) return;

      await fileService.deleteFromS3UsingLink(file.url);

      await Files.findByIdAndDelete(fileId);
    } catch {
      /* empty */
    }
  };

  static deleteFilesInBin = async () => {
    try {
      const daysAgo = removeDays(new Date(), TRASHBIN_NO_OF_DAYS);
      const files = await Files.find(
        {
          updatedAt: { $lt: daysAgo },
          status: CURRENT_STATUS.DELETED,
        },
        { url: 1 },
      );

      const fileIds = [],
        imageUrls = [];

      files.forEach((file) => {
        fileIds.push(file._id);
        imageUrls.push(file.url);
      });

      await Promise.all([
        Files.deleteMany({ _id: { $in: fileIds } }),
        imageUrls.map(
          async (url) => await fileService.deleteFromS3UsingLink(url),
        ),
      ]);
    } catch {
      /* empty */
    }
  };
}
