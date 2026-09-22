import { ProjectTasks } from "../db";
import { TRASHBIN_NO_OF_DAYS } from "../utils/constants/constants";
import { CURRENT_TASK_STATUS } from "../utils/enums/enums";
import { removeDays } from "../utils/helpers/commonHelper";
import { fileService } from "./awsBucket";

export class TasksService {
  static async deleteTasksInBin() {
    try {
      const daysAgo = removeDays(new Date(), TRASHBIN_NO_OF_DAYS);
      const tasks = await ProjectTasks.find(
        {
          updatedAt: { $lt: daysAgo },
          status: CURRENT_TASK_STATUS.DELETED,
          taskImage: { $exists: true },
        },
        { taskImage: 1 },
      );

      await Promise.all([
        tasks.map((task) => {
          fileService.deleteFromS3UsingLink(task.taskImage);
        }),
        ProjectTasks.deleteMany({
          updatedAt: { $lt: daysAgo },
          status: CURRENT_TASK_STATUS.DELETED,
        }),
      ]);
    } catch {
      /* empty */
    }
  }

  static async deleteTaskById(taskId) {
    try {
      const task = await ProjectTasks.findById(taskId);

      if (task?.taskImage) {
        await fileService.deleteFromS3UsingLink(task.taskImage);
      }

      await ProjectTasks.findByIdAndDelete(taskId);
    } catch {
      /* empty */
    }
  }
}
