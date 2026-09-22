import { Types } from "mongoose";

import { Sheets } from "../../db";
import { SHEET_STATUS } from "../../utils/enums/sheet";
import { ISheetCreatePayload, ISheetInput } from "../../utils/interfaces/sheet";
import { DailyLogHelpers } from "../dailyLog/helpers";

type mongoId = Types.ObjectId;

export class SheetHelpers {
  public static create = (payload: ISheetCreatePayload) => {
    return Sheets.create(payload);
  };

  public static findById = (sheetId: mongoId) => {
    return Sheets.findOne({
      _id: sheetId,
      status: { $ne: SHEET_STATUS.DELETED },
    }).lean();
  };

  public static update = (sheetId: mongoId, update: ISheetInput) => {
    return Sheets.findByIdAndUpdate(
      sheetId,
      { $set: update },
      { new: true },
    ).lean();
  };

  // Soft delete, matching daily logs and project updates.
  public static moveToTrash = (sheetId: mongoId) => {
    return Sheets.findByIdAndUpdate(sheetId, {
      $set: { status: SHEET_STATUS.DELETED },
    });
  };

  // Same company logo / author line every document's PDF header uses.
  public static findBranding = DailyLogHelpers.findBranding;
}
