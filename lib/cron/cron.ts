import * as express from "express";
import * as http from "http";
import * as cron from "node-cron";
import mongoose from "mongoose";
import { config } from "../utils/configuration/config";
import {
  connectDB,
  flushBufferedDbLogs,
  recordDbConnectionEvent,
} from "../services/connectDB";
import { connectRedis } from "../services/redis";
import { warmAllAllowlistedCompanies } from "../services/redis/postCacheWarmer";
import "../services/redis/cacheWarmerSetup";
import { GalleriesCronHelper } from "./helpers/gallery";
import { PostService } from "../services/posts";
import { TasksService } from "../services/tasks";
import { ChecklistsServices } from "../services/checklists";
import { ProjectReportServices } from "../services/projectReport";
import { FilesService } from "../services/files";
import { ProjectService } from "../services/projects";
import { processPendingRetryJobs } from "../integrations/syncService";
import { backfillMissedPhotoSyncs } from "../integrations/photoBackfill";
import { emitClusterStatus } from "../search/clusterStatusMetric";
import { SalesforceAccountSyncService } from "../services/salesforceAccountSync";
import { PendingUploadService } from "../services/pendingUploads";

const startCronServer = async () => {
  try {
    connectDB();
    connectRedis();
    const app = express();
    const port = config.CRON_PORT || "8001";
    app.set("port", port);

    const server = http.createServer(app);

    cron.schedule("0 0 * * *", async () => {
      await PostService.deletePostsInBin();
    });

    cron.schedule("2 0 0 * * *", async () => {
      await GalleriesCronHelper.deleteOldGallaries();
    });

    cron.schedule("4 0 0 * * *", async () => {
      await TasksService.deleteTasksInBin();
    });

    cron.schedule("6 0 0 * * *", async () => {
      await ChecklistsServices.deleteChecklistsInBin();
    });

    cron.schedule("8 0 0 * * *", async () => {
      await ProjectReportServices.deleteReportsInBin();
    });

    cron.schedule("10 0 0 * * *", async () => {
      await FilesService.deleteFilesInBin();
    });

    cron.schedule("12 0 0 * * *", async () => {
      await PostService.permanentlyDeleteExpiredPostFiles();
    });

    // Projects binned longer than TRASHBIN_NO_OF_DAYS (30) are purged
    // with all of their content. Runs last in the nightly sequence so the
    // per-entity purges above have already cleared anything they own.
    cron.schedule("14 0 0 * * *", async () => {
      await ProjectService.deleteProjectsInBin();
    });

    // External-API uploads that were signed for but never attached to a post,
    // note or project. Runs after the nightly bin purges so anything deleted
    // above is already out of the way. See lib/services/pendingUploads.ts for
    // why only /v1 uploads are eligible.
    cron.schedule("16 0 0 * * *", async () => {
      try {
        const summary = await PendingUploadService.sweepOrphans();
        summary.multipartAborted =
          await PendingUploadService.abortStaleMultipartUploads();

        if (summary.deleted || summary.failures || summary.multipartAborted) {
          console.info("Orphaned upload sweep completed:", summary);
        }
      } catch (error) {
        console.error("Error sweeping orphaned uploads:", error);
      }
    });

    // Publish the ES cluster_status gauge every minute for the operational dashboard. emitClusterStatus swallows its own errors (never throws), so no try/catch here.
    cron.schedule("* * * * *", async () => {
      await emitClusterStatus();
    });

    // Process pending CRM integration retry jobs every 5 minutes
    cron.schedule("*/5 * * * *", async () => {
      try {
        await processPendingRetryJobs();
      } catch (error) {
        console.error("Error processing integration retry jobs:", error);
      }
    });

    // Catch photos in integration-linked projects that never got an outbound
    // sync job (hook failed / post created off the hook path / integration
    // connected late). Runs hourly at :20 to stay clear of the 5-minute retry
    // drain, which is what actually uploads the jobs this queues.
    cron.schedule("20 * * * *", async () => {
      try {
        const summary = await backfillMissedPhotoSyncs();

        if (
          summary.postFilesEnqueued ||
          summary.projectFilesEnqueued ||
          summary.reclaimedStuckJobs ||
          summary.failures.length
        ) {
          console.info("Missed photo sync backfill completed:", summary);
        }

        if (summary.truncatedIntegrations.length) {
          console.warn(
            "Photo backfill hit its per-integration scan limit; some media was not inspected this run:",
            summary.truncatedIntegrations,
          );
        }
      } catch (error) {
        console.error("Error backfilling missed photo syncs:", error);
      }
    });

    cron.schedule("* * * * *", async () => {
      try {
        const readyState = mongoose.connection.readyState;
        if (readyState === 1) {
          await flushBufferedDbLogs();
          return;
        }
        if (readyState === 2) {
          return;
        }
        await connectDB();
      } catch (error) {
        recordDbConnectionEvent({
          errorType: "DB_HEALTH_CHECK_ERROR",
          message: error instanceof Error ? error.message : String(error),
          error: error instanceof Error ? error : undefined,
          metadata: {
            source: "hourly-cron",
            readyState: mongoose.connection.readyState,
          },
        });
      }
    });

    cron.schedule("0 8 * * *", async () => {
      try {
        await warmAllAllowlistedCompanies();
      } catch (error) {
        console.error("Error warming posts uploads cache:", error);
      }
    });

    // Push company-level account state onto each admin's Salesforce lead so
    // account managers see fresh usage every morning. Runs at 03:00 because the
    // usage roll-up scans several large collections.
    cron.schedule("0 3 * * *", async () => {
      try {
        const { resolution, push } =
          await SalesforceAccountSyncService.runDailySync();
        console.info("Salesforce account sync completed:", {
          totalAccounts: push.totalAccounts,
          updated: push.updated,
          failed: push.failed,
          skipped: push.skipped,
          duplicateLeads: push.duplicateLeads,
          // Converted leads can't be written to, so these landed on the Contact.
          updatedContacts: push.updatedContacts,
          contactIdsLinked: push.contactIdsLinked,
          staleIdsCleared: push.staleIdsCleared,
          leadsLinkedByEmail: resolution.matchedByEmail,
          contactsLinkedByEmail: resolution.matchedContacts,
          leadsCreated: resolution.createdLeads,
          durationMs: push.durationMs,
        });

        // Cap the log lines — a broad Salesforce outage would otherwise dump one
        // entry per account.
        if (resolution.failures.length) {
          console.error(
            "Salesforce lead resolution failures (first 20):",
            resolution.failures.slice(0, 20),
          );
        }
        if (push.failures.length) {
          console.error(
            "Salesforce account sync failures (first 20):",
            push.failures.slice(0, 20),
          );
        }
      } catch (error) {
        console.error("Error syncing accounts to Salesforce:", error);
      }
    });

    server.listen(port, () => {
      console.info("Cron server is running on localhost:" + port);
    });
  } catch (error) {
    process.exit(1);
  }
};

startCronServer();
