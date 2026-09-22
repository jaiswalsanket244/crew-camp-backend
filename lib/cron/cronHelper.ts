import { spawn } from "child_process";
import * as fs from "fs";
import { config } from "../utils/configuration/config";
import { fileService } from "../services/awsBucket";
import * as dayjs from "dayjs";

export class CronHelper {
  public static backUpLocalData = async () => {
    try {
      const filePath: string = `${config.BACKUP_PATH}/${config.LOCAL_DB_FILE}`;

      // Backup local data using mongodump
      const backupProcess = spawn("mongodump", [
        `--db=${config.DB_PATH}`,
        `--archive=${filePath}`,
        "--gzip",
      ]);

      // listen to child process event
      backupProcess.on("exit", async () => {
        // Read the backup file
        const fileContent = fs.readFileSync(filePath);

        // Upload to S3
        const fileName = `${dayjs().format("DD-MM-YY")}.archive`;
        await fileService.uploadToS3({ name: fileName, data: fileContent });

        // Delete the local backup
        CronHelper.deleteFromLocal(filePath);
      });
    } catch (error) {
      console.error("Error in backUpLocalData:", error);
    }
  };

  public static deleteFromLocal = (filePath: string) => {
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error("Error deleting file from local:", err);
        throw err;
      } else {
        console.info("File deleted from local!");
      }
    });
  };
}
