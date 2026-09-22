import { Types } from "mongoose";

import { Company, DailyLogs, User } from "../../db";
import { DAILY_LOG_STATUS } from "../../utils/enums/dailyLog";
import {
  IDailyLogBranding,
  IDailyLogCreatePayload,
  IDailyLogInput,
} from "../../utils/interfaces/dailyLog";

type mongoId = Types.ObjectId;

const LIST_LIMIT = 200;

export class DailyLogHelpers {
  public static create = (payload: IDailyLogCreatePayload) => {
    return DailyLogs.create(payload);
  };

  public static findById = (dailyLogId: mongoId) => {
    return DailyLogs.findOne({
      _id: dailyLogId,
      status: { $ne: DAILY_LOG_STATUS.DELETED },
    }).lean();
  };

  public static update = (dailyLogId: mongoId, update: IDailyLogInput) => {
    return DailyLogs.findByIdAndUpdate(
      dailyLogId,
      { $set: update },
      { new: true },
    ).lean();
  };

  public static listByProject = (projectId: mongoId, companyId: mongoId) => {
    return DailyLogs.aggregate([
      {
        $match: {
          projectId,
          companyId,
          status: { $ne: DAILY_LOG_STATUS.DELETED },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: LIST_LIMIT },
      // The list renders cards only; overviewDoc/notesDoc/photos are the bulk of
      // a document and would make this response very large.
      {
        $project: {
          title: 1,
          summaryDate: 1,
          status: 1,
          createdAt: 1,
          updatedAt: 1,
          photoCount: { $size: { $ifNull: ["$photos", []] } },
        },
      },
    ]);
  };

  public static findBranding = async (params: {
    companyId: mongoId;
    userId: mongoId;
  }): Promise<IDailyLogBranding> => {
    const [company, author] = await Promise.all([
      Company.findById(params.companyId, { name: 1, companyLogo: 1 }).lean(),
      User.findById(params.userId, { name: 1 }).lean(),
    ]);
    const filedBy = [author?.name?.first, author?.name?.last]
      .filter(Boolean)
      .join(" ");
    return {
      companyName: company?.name ?? "",
      companyLogo: company?.companyLogo ?? "",
      filedBy,
    };
  };

  // Soft delete, matching projectReports — keeps the document recoverable.
  public static moveToTrash = (dailyLogId: mongoId) => {
    return DailyLogs.findByIdAndUpdate(dailyLogId, {
      $set: { status: DAILY_LOG_STATUS.DELETED },
    });
  };
}
