import { ProjectReports } from "../db";
import { ProjectReportsHelpers } from "../routes/projectReport/helpers";
import { TRASHBIN_NO_OF_DAYS } from "../utils/constants/constants";
import { CURRENT_STATUS } from "../utils/enums/enums";
import { removeDays } from "../utils/helpers/commonHelper";
import { ObjectIdType } from "../utils/interfaces/schemaInterface";
import { fileService } from "./awsBucket";

export class ProjectReportServices {
  static deleteReportById = async (reportId: ObjectIdType) => {
    const subSectionsWithImages =
      await ProjectReportsHelpers.getReportSubSectionsWithImages(reportId);

    const imageUrls = subSectionsWithImages.map((section) => section.image);

    await Promise.all([
      ProjectReportsHelpers.delete(reportId),
      imageUrls.map(
        async (url) => await fileService.deleteFromS3UsingLink(url),
      ),
    ]);
  };

  static async deleteReportsInBin() {
    try {
      const daysAgo = removeDays(new Date(), TRASHBIN_NO_OF_DAYS);
      const posts = await ProjectReports.find(
        {
          updatedAt: { $lt: daysAgo },
          status: CURRENT_STATUS.DELETED,
        },
        { _id: 1 },
      );

      await Promise.all(
        posts.map(async (report) => {
          await this.deleteReportById(report._id);
        }),
      );
    } catch {
      /* empty */
    }
  }
}
