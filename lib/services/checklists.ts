import { Checklist, TodoList, TodoListImages } from "../db";
import { TRASHBIN_NO_OF_DAYS } from "../utils/constants/constants";
import { CHECKLIST_STATUS } from "../utils/enums/checklist";
import { removeDays } from "../utils/helpers/commonHelper";
import { fileService } from "./awsBucket";

export class ChecklistsServices {
  public static async deleteChecklistsInBin() {
    try {
      const daysAgo = removeDays(new Date(), TRASHBIN_NO_OF_DAYS);

      const trashBinquery = {
        status: CHECKLIST_STATUS.DELETED,
        updatedAt: { $lt: daysAgo },
      };

      const checklistsInBin = await Checklist.find(trashBinquery, { _id: 1 });

      if (checklistsInBin.length === 0) {
        return;
      }
      const checklistIds = checklistsInBin.map((checklist) => checklist._id);

      const checklistIdsQuery = { checklistId: { $in: checklistIds } };
      const todoListImages = await TodoListImages.find(checklistIdsQuery, {
        imageData: 1,
      });

      await Promise.all([
        todoListImages.map((todo) =>
          fileService.deleteFromS3UsingLink(todo.imageData.url),
        ),
        Checklist.deleteMany(trashBinquery),
        TodoList.deleteMany(checklistIdsQuery),
        TodoListImages.deleteMany(checklistIdsQuery),
      ]);
    } catch {
      /* empty */
    }
  }

  public static async deleteChecklistById(checklistId) {
    try {
      const query = { checklistId: checklistId };
      const todoListImages = await TodoListImages.find(query, {
        imageData: 1,
      });

      await Promise.all([
        todoListImages.map((todo) =>
          fileService.deleteFromS3UsingLink(todo.imageData.url),
        ),
        Checklist.findByIdAndDelete(checklistId),
        TodoList.deleteMany(query),
        TodoListImages.deleteMany(query),
      ]);
    } catch {
      /* empty */
    }
  }
}
