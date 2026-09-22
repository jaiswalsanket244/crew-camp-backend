import { Types } from "mongoose";

import { AiProjectUpdates, PostFiles } from "../../db";
import { AI_PROJECT_UPDATE_STATUS } from "../../utils/enums/aiProjectUpdate";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import {
  IAiProjectUpdateCreatePayload,
  IAiProjectUpdateInput,
  IAiProjectUpdateListItem,
  IAiProjectUpdateListPage,
} from "../../utils/interfaces/aiProjectUpdate";
import { DailyLogHelpers } from "../dailyLog/helpers";
import { buildUpdateListMatch } from "./listQuery";

type mongoId = Types.ObjectId;

// The subset of a postFiles row the routes need: membership proof plus the
// server-owned copy of the photo URLs.
export interface IPostFileRef {
  _id: mongoId;
  postId: mongoId;
  url?: string;
  quickView?: string;
}

export class AiProjectUpdateHelpers {
  public static create = (payload: IAiProjectUpdateCreatePayload) => {
    return AiProjectUpdates.create(payload);
  };

  public static findById = (updateId: mongoId) => {
    return AiProjectUpdates.findOne({
      _id: updateId,
      status: { $ne: AI_PROJECT_UPDATE_STATUS.DELETED },
    }).lean();
  };

  public static update = (updateId: mongoId, update: IAiProjectUpdateInput) => {
    return AiProjectUpdates.findByIdAndUpdate(
      updateId,
      { $set: update },
      { new: true },
    ).lean();
  };

  // Paged, searchable list. Unlike the daily-log list this returns a total so
  // the tab can say "Showing 50 of N". overviewDoc/photos are projected away —
  // they are the bulk of a document and the cards never need them.
  public static listByProject = async (
    projectId: mongoId,
    companyId: mongoId,
    paging: { page: number; limit: number; search?: string },
  ): Promise<IAiProjectUpdateListPage> => {
    const match = buildUpdateListMatch(projectId, companyId, paging.search);
    const [total, items] = await Promise.all([
      AiProjectUpdates.countDocuments(match),
      AiProjectUpdates.aggregate([
        { $match: match },
        { $sort: { updatedAt: -1, _id: -1 } },
        { $skip: (paging.page - 1) * paging.limit },
        { $limit: paging.limit },
        {
          $project: {
            title: 1,
            startDate: 1,
            endDate: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            photoCount: { $size: { $ifNull: ["$photos", []] } },
          },
        },
      ]) as unknown as Promise<IAiProjectUpdateListItem[]>,
    ]);
    return { items, total };
  };

  // Same company logo / author line the daily-log PDF header uses.
  public static findBranding = DailyLogHelpers.findBranding;

  // Soft delete, matching daily logs and projectReports.
  public static moveToTrash = (updateId: mongoId) => {
    return AiProjectUpdates.findByIdAndUpdate(updateId, {
      $set: { status: AI_PROJECT_UPDATE_STATUS.DELETED },
    });
  };

  // Active post files that belong to the project. One round trip serves both
  // the membership check (every requested id must come back) and the
  // server-owned url/quickView/postId that overwrite the client's copies.
  public static findProjectPostFiles = (
    fileIds: string[],
    projectId: mongoId,
  ): Promise<IPostFileRef[]> => {
    return PostFiles.find(
      {
        _id: { $in: fileIds.map((id) => new Types.ObjectId(id)) },
        projectId,
        status: CURRENT_STATUS.ACTIVE,
      },
      { url: 1, quickView: 1, postId: 1 },
    ).lean() as unknown as Promise<IPostFileRef[]>;
  };
}
