/**
 * Sync Service
 *
 * Handles processing of sync jobs with retry logic.
 * Manages both inbound (CRM -> CrewCam) and outbound (CrewCam -> CRM) sync.
 */

import {
  Integration,
  SyncJob,
  Project,
  ProcessedWebhook,
  Company,
} from "../db";
import { ISyncJob } from "../db/syncJob";
import { createIntegrationManager } from "./manager";
import {
  ActivityPushPayload,
  IIntegration,
  InboundProjectData,
  OutboundPhotoJobInput,
  PhotoUploadPayload,
} from "../utils/interfaces/integrations";
import { syncTagsToProject } from "./webhookHelpers";
import mongoose from "mongoose";
import { geocodeStructuredAddress } from "../services/geocodingService";
import { ProjectHelper } from "../routes/projects/helper";
import { CRM_SYNC_AUTO_JOIN_ALL_MEMBERS_COMPANY_IDS } from "../utils/constants/constants";

// Retry delays in milliseconds (exponential backoff)
const RETRY_DELAYS = [
  30 * 1000, // 30 seconds
  2 * 60 * 1000, // 2 minutes
  8 * 60 * 1000, // 8 minutes
  32 * 60 * 1000, // 32 minutes
  2 * 60 * 60 * 1000, // 2 hours
];

type ProjectDoc = InstanceType<typeof Project>;

// In-flight inbound syncs, keyed by company+provider+externalId.
const inboundRecordLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize work per external CRM record within this process.
 *
 * Two webhooks for the same JobNimbus job can arrive in the same second; each
 * spawns its own sync job, and both would otherwise read "no existing project"
 * before either had inserted one. Chaining them means the second run sees the
 * first run's project and takes the update path instead of inserting a duplicate.
 */
function withInboundRecordLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = inboundRecordLocks.get(key) || Promise.resolve();
  // Run regardless of whether the previous holder resolved or rejected.
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  inboundRecordLocks.set(key, tail);
  void tail.then(() => {
    if (inboundRecordLocks.get(key) === tail) {
      inboundRecordLocks.delete(key);
    }
  });
  return run;
}

/**
 * Atomically claim a job for processing.
 * Uses findOneAndUpdate with status check to prevent race conditions.
 * Only one process can successfully claim a pending job.
 *
 * @returns The job if successfully claimed, null if already claimed or not found.
 */
async function claimJob(jobId: string): Promise<ISyncJob | null> {
  const job = await SyncJob.findOneAndUpdate(
    {
      _id: jobId,
      status: "pending",
    },
    {
      status: "processing",
      lastAttemptAt: new Date(),
    },
    { new: true },
  );
  return job as ISyncJob | null;
}

/**
 * Create a sync job for inbound project creation.
 */
export async function createInboundSyncJob(
  integrationId: mongoose.Types.ObjectId,
  externalId: string,
  payload: Record<string, unknown>,
): Promise<ISyncJob> {
  const job = await SyncJob.create({
    integrationId,
    type: "inbound_project",
    status: "pending",
    payload: {
      externalId,
      ...payload,
    },
    attempts: 0,
    maxAttempts: 5,
  });

  // Process immediately (async, don't await)
  processInboundJob(job._id.toString()).catch((err) => {
    console.error("Error processing inbound job:", err);
  });

  return job as unknown as ISyncJob;
}

/**
 * Create a sync job for outbound photo upload.
 */
export async function createOutboundSyncJob(
  integrationId: mongoose.Types.ObjectId,
  projectId: mongoose.Types.ObjectId,
  externalProjectId: string,
  photoPayload: PhotoUploadPayload,
): Promise<ISyncJob> {
  const job = await SyncJob.create({
    integrationId,
    projectId,
    type: "outbound_photo",
    status: "pending",
    payload: {
      externalProjectId,
      photo: {
        fileUrl: photoPayload.fileUrl,
        fileName: photoPayload.fileName,
        mimeType: photoPayload.mimeType,
        uploadedBy: photoPayload.uploadedBy,
        uploadedAt: photoPayload.uploadedAt,
        projectName: photoPayload.projectName,
        projectUrl: photoPayload.projectUrl,
        postUrl: photoPayload.postUrl,
        tags: photoPayload.tags,
      },
    },
    attempts: 0,
    maxAttempts: 5,
  });

  // Process immediately (async, don't await)
  processOutboundJob(job._id.toString()).catch((err) => {
    console.error("Error processing outbound job:", err);
  });

  return job as unknown as ISyncJob;
}

/**
 * Create a sync job that pushes a post's note to the CRM as an activity.
 *
 * Separate from the per-file photo jobs: one post produces N photo jobs but a
 * single activity job, so the note isn't repeated once per photo.
 */
export async function createOutboundActivityJob(
  integrationId: mongoose.Types.ObjectId,
  projectId: mongoose.Types.ObjectId,
  externalProjectId: string,
  activity: ActivityPushPayload,
): Promise<ISyncJob> {
  const job = await SyncJob.create({
    integrationId,
    projectId,
    type: "outbound_activity",
    status: "pending",
    payload: {
      externalProjectId,
      activity,
    },
    attempts: 0,
    maxAttempts: 5,
  });

  // Process immediately (async, don't await)
  processOutboundActivityJob(job._id.toString()).catch((err) => {
    console.error("Error processing outbound activity job:", err);
  });

  return job as unknown as ISyncJob;
}

/**
 * Bulk-enqueue outbound photo jobs without processing them inline.
 *
 * Unlike createOutboundSyncJob (which fires the upload immediately), these are
 * left `pending` with nextRetryAt=now so processPendingRetryJobs drains them in
 * capped batches. Used by the backfill cron, which can enqueue hundreds at once.
 */
export async function enqueueOutboundPhotoJobs(
  jobs: OutboundPhotoJobInput[],
): Promise<number> {
  if (!jobs.length) return 0;

  const now = new Date();
  const docs = jobs.map((job) => ({
    integrationId: job.integrationId,
    projectId: job.projectId,
    type: "outbound_photo",
    status: "pending",
    payload: {
      externalProjectId: job.externalProjectId,
      photo: job.photo,
    },
    attempts: 0,
    maxAttempts: 5,
    nextRetryAt: now,
  }));

  const inserted = await SyncJob.insertMany(docs, { ordered: false });
  return inserted.length;
}

/**
 * Re-queue outbound jobs stranded in `processing` by a server restart.
 * Covers both photo and activity pushes. Only jobs with retries left are
 * reclaimed; the rest stay put for inspection.
 */
export async function reclaimStuckOutboundJobs(
  staleMinutes: number,
): Promise<number> {
  const staleBefore = new Date(Date.now() - staleMinutes * 60 * 1000);

  const result = await SyncJob.updateMany(
    {
      type: { $in: ["outbound_photo", "outbound_activity"] },
      status: "processing",
      lastAttemptAt: { $lt: staleBefore },
      $expr: { $lt: ["$attempts", "$maxAttempts"] },
    },
    {
      $set: { status: "pending", nextRetryAt: new Date() },
    },
  );

  return result.modifiedCount || 0;
}

/**
 * Process an inbound sync job (CRM job -> CrewCam project).
 */
async function processInboundJob(jobId: string): Promise<void> {
  const job = await claimJob(jobId);
  if (!job) {
    // Job doesn't exist or already claimed by another process
    return;
  }

  try {
    const integration = await Integration.findById(job.integrationId);
    if (!integration) {
      throw new Error("Integration not found");
    }

    // Check if inbound sync is enabled
    if (!integration.settings.inboundSyncEnabled) {
      await SyncJob.findByIdAndUpdate(jobId, {
        status: "completed",
        result: {
          success: true,
          errorMessage: "Inbound sync disabled, skipping",
        },
      });
      return;
    }

    const externalId = job.payload.externalId as string;
    const webhookData = job.payload as Record<string, unknown>;

    const manager = createIntegrationManager(
      integration as unknown as IIntegration,
    );

    // Providers that own their inbound mapping (e.g. Proline) normalize the
    // payload themselves and skip the JobNimbus-shaped extraction below. This
    // has to run before the `type` gate: `type` is a JobNimbus record kind, and
    // other CRMs use the same key for unrelated values.
    if (manager.supportsInboundNormalization) {
      const normalized = await manager.normalizeInboundPayload(webhookData);

      if (!normalized) {
        await SyncJob.findByIdAndUpdate(jobId, {
          status: "completed",
          result: {
            success: true,
            errorMessage: `Payload not syncable for provider ${integration.provider}, skipping`,
          },
        });
        return;
      }

      await finalizeInboundProject(
        jobId,
        integration as unknown as IIntegration,
        normalized.projectType || "project",
        normalized,
      );
      return;
    }

    const payloadType = (webhookData.type as string) || "job";

    // Only process if type is "job" or "contact"
    if (payloadType !== "job" && payloadType !== "contact") {
      await SyncJob.findByIdAndUpdate(jobId, {
        status: "completed",
        result: {
          success: true,
          errorMessage: `Skipping sync for type: ${payloadType}. Only 'job' and 'contact' types are processed as projects.`,
        },
      });
      return;
    }

    // Parse project data from webhook payload (no need to call API again)
    const jobData = webhookData as any;

    // Geocode address to get formatted string and coordinates

    const geocodedAddress = await geocodeStructuredAddress({
      line1: jobData?.address_line1,
      line2: jobData?.address_line2,
      city: jobData?.city,
      state: jobData?.state_text,
      zip: jobData?.zip,
      country: jobData?.country_name,
    });

    // Extract customer name from primary contact
    let customerName: string | undefined;
    if (jobData?.primary) {
      if (jobData.primary.name) {
        customerName = jobData.primary.name;
      } else {
        const nameParts = [
          jobData.primary.first_name,
          jobData.primary.last_name,
        ].filter(Boolean);
        customerName = nameParts.length > 0 ? nameParts.join(" ") : undefined;
      }
    }

    // Determine the project name based on type
    let projectName: string;
    if (payloadType === "contact") {
      // For contact type, use display_name or construct from first/last name
      projectName =
        jobData.display_name ||
        `${jobData.first_name || ""} ${jobData.last_name || ""}`.trim() ||
        jobData.name ||
        "Untitled Contact";
    } else {
      // For job type, use the existing logic
      projectName = jobData.display_name || jobData.name || "Untitled Job";
    }

    // Determine the external URL based on type
    const externalUrl =
      payloadType === "contact"
        ? `https://app.jobnimbus.com/contact/${jobData.jnid || externalId}`
        : `https://app.jobnimbus.com/job/${jobData.jnid || externalId}`;

    const externalProject = {
      externalId: jobData.jnid || externalId,
      externalUrl,
      name: projectName,
      address: geocodedAddress?.formattedAddress,
      customerName,
      customerEmail: jobData.primary?.email || jobData.email,
      customerPhone:
        jobData.primary?.phone ||
        jobData.mobile_phone ||
        jobData.home_phone ||
        jobData.work_phone,
      coordinates: geocodedAddress
        ? {
            latitude: geocodedAddress.latitude,
            longitude: geocodedAddress.longitude,
          }
        : undefined,
      rawData: webhookData,
      projectType: payloadType, // Add type to track whether this came from a job or contact
    };

    await finalizeInboundProject(
      jobId,
      integration as unknown as IIntegration,
      payloadType,
      externalProject,
    );
  } catch (error) {
    await handleJobError(jobId, error);
  }
}

/**
 * Upsert the CrewCam project for a normalized inbound payload, sync its tags,
 * and close out the sync job. Shared by every provider's inbound path.
 */
async function finalizeInboundProject(
  jobId: string,
  integration: IIntegration,
  payloadType: string,
  externalProject: InboundProjectData,
): Promise<void> {
  // Serialized per external record so concurrent webhooks for the same CRM job
  // can't both take the "create" branch and produce duplicate projects.
  const project = await withInboundRecordLock(
    `${integration.companyId.toString()}:${integration.provider}:${externalProject.externalId}`,
    () =>
      resolveInboundProject(
        integration,
        externalProject.externalId,
        payloadType,
        externalProject,
      ),
  );

  // Ensure project exists before syncing tags
  if (!project) {
    throw new Error("Failed to create or update project");
  }

  // Prefer the provider-normalized tag list; fall back to raw payload tags.
  const tagNames =
    externalProject.tags ??
    (Array.isArray(externalProject.rawData?.tags)
      ? (externalProject.rawData.tags as string[])
      : undefined);

  if (tagNames?.length) {
    try {
      await syncTagsToProject(project._id, tagNames, integration.companyId);
    } catch (tagError) {
      // Log tag sync errors but don't fail the entire job
      console.error(
        `Failed to sync tags for project ${project._id}:`,
        tagError,
      );
    }
  }

  // Update job as completed
  await SyncJob.findByIdAndUpdate(jobId, {
    status: "completed",
    projectId: project._id,
    result: {
      success: true,
      externalId: externalProject.externalId,
    },
  });

  // Update integration last successful sync
  await Integration.findByIdAndUpdate(integration._id, {
    lastSuccessfulSync: new Date(),
    lastError: null,
  });
}

/**
 * Find the CrewCam project mapped to a CRM record and update it, or create it.
 *
 * Callers must hold the per-record lock (see withInboundRecordLock) — that covers
 * concurrent webhooks inside one process. The duplicate-key branch covers the
 * cross-process case: the unique partial index on
 * {companyId, externalMapping.system, externalMapping.externalId} turns a lost
 * insert race into an E11000 instead of a second project, and we then adopt the
 * winner and apply this payload as an update.
 */
async function resolveInboundProject(
  integration: IIntegration,
  externalId: string,
  payloadType: string,
  externalProject: InboundProjectData,
): Promise<ProjectDoc | null> {
  const mappingFilter = {
    companyId: integration.companyId,
    "externalMapping.system": integration.provider,
    "externalMapping.externalId": externalId,
  };

  const existingProject = await Project.findOne(mappingFilter);
  if (existingProject) {
    return applyInboundUpdate(existingProject, payloadType, externalProject);
  }

  const adminId = await Company.findById(integration.companyId, { userId: 1 });

  const projectData: Record<string, unknown> = {
    name: externalProject.name, // Use the correctly formatted name
    location: externalProject.address || "",
    // Provider-normalized description wins; JobNimbus reads it off rawData.
    description:
      externalProject.description || externalProject.rawData?.description || "",
    companyId: integration.companyId,
    status: "ACTIVE",
    externalMapping: {
      system: integration.provider,
      externalId,
      externalUrl: externalProject.externalUrl,
      projectType: payloadType, // Track the source type
      syncedAt: new Date(),
    },
  };

  // Add coordinates if available from geocoding
  if (externalProject.coordinates?.latitude) {
    projectData.coordinates = {
      latitude: externalProject.coordinates.latitude,
      longitude: externalProject.coordinates.longitude,
    };
  }

  if (adminId?.userId) {
    projectData.userId = adminId.userId;
  }

  let project: ProjectDoc;
  try {
    project = await Project.create(projectData);
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) {
      throw error;
    }
    // Another process inserted this mapping first; treat the payload as an update.
    const winner = await Project.findOne(mappingFilter);
    if (!winner) {
      throw error;
    }
    return applyInboundUpdate(winner, payloadType, externalProject);
  }

  if (adminId?.userId) {
    await ProjectHelper.addToProject(project._id, adminId.userId);
  }

  // Some companies want every member on CRM-created projects automatically.
  if (
    CRM_SYNC_AUTO_JOIN_ALL_MEMBERS_COMPANY_IDS.includes(
      integration.companyId.toString(),
    )
  ) {
    try {
      await ProjectHelper.addAllCompanyMembersToProject(
        project._id,
        integration.companyId,
      );
    } catch (memberError) {
      // Don't fail the sync job if the bulk member add fails
      console.error(
        `Failed to auto-join company members to project ${project._id}:`,
        memberError,
      );
    }
  }

  return project;
}

/**
 * Apply an inbound CRM payload to an already-mapped project.
 */
async function applyInboundUpdate(
  existingProject: ProjectDoc,
  payloadType: string,
  externalProject: InboundProjectData,
): Promise<ProjectDoc | null> {
  const updateData: Record<string, unknown> = {
    name: externalProject.name, // Use the correctly formatted name
    location: externalProject.address,
    description:
      externalProject.description || externalProject.rawData?.description || "",
    "externalMapping.syncedAt": new Date(),
    "externalMapping.externalUrl": externalProject.externalUrl,
    "externalMapping.projectType": payloadType, // Track the source type
  };

  // Update coordinates if available from geocoding
  if (
    !existingProject.coordinates?.latitude &&
    externalProject.coordinates?.latitude
  ) {
    updateData["coordinates.latitude"] = externalProject.coordinates.latitude;
    updateData["coordinates.longitude"] = externalProject.coordinates.longitude;
  }

  return Project.findByIdAndUpdate(existingProject._id, updateData, {
    new: true,
  });
}

/**
 * Process an outbound sync job (CrewCam photo -> CRM).
 */
async function processOutboundJob(jobId: string): Promise<void> {
  const job = await claimJob(jobId);
  if (!job) {
    // Job doesn't exist or already claimed by another process
    return;
  }

  try {
    const integration = await Integration.findById(job.integrationId);
    if (!integration) {
      throw new Error("Integration not found");
    }

    // Check if outbound sync is enabled
    if (!integration.settings.outboundSyncEnabled) {
      await SyncJob.findByIdAndUpdate(jobId, {
        status: "completed",
        result: {
          success: true,
          errorMessage: "Outbound sync disabled, skipping",
        },
      });
      return;
    }

    const manager = createIntegrationManager(
      integration as unknown as IIntegration,
    );

    const payload = job.payload as {
      externalProjectId: string;
      photo: PhotoUploadPayload;
    };

    // Convert date string back to Date object
    const photoPayload: PhotoUploadPayload = {
      ...payload.photo,
      uploadedAt: new Date(payload.photo.uploadedAt),
    };

    // Upload photo to CRM
    const result = await manager.uploadPhoto(
      payload.externalProjectId,
      photoPayload,
    );

    if (!result.success) {
      throw new Error(result.errorMessage || "Upload failed");
    }

    // Update job as completed
    await SyncJob.findByIdAndUpdate(jobId, {
      status: "completed",
      result: {
        success: true,
        externalId: result.externalAttachmentId,
        rawResponse: result.rawResponse,
      },
    });

    // Update project last outbound sync
    if (job.projectId) {
      await Project.findByIdAndUpdate(job.projectId, {
        "externalMapping.lastOutboundSync": new Date(),
        "externalMapping.lastSyncError": null,
      });
    }

    // Update integration last successful sync
    await Integration.findByIdAndUpdate(integration._id, {
      lastSuccessfulSync: new Date(),
      lastError: null,
    });
  } catch (error) {
    await handleJobError(jobId, error);
  }
}

/**
 * Process an outbound activity sync job (CrewCam post note -> CRM activity).
 */
async function processOutboundActivityJob(jobId: string): Promise<void> {
  const job = await claimJob(jobId);
  if (!job) {
    // Job doesn't exist or already claimed by another process
    return;
  }

  try {
    const integration = await Integration.findById(job.integrationId);
    if (!integration) {
      throw new Error("Integration not found");
    }

    if (!integration.settings.outboundSyncEnabled) {
      await SyncJob.findByIdAndUpdate(jobId, {
        status: "completed",
        result: {
          success: true,
          errorMessage: "Outbound sync disabled, skipping",
        },
      });
      return;
    }

    const manager = createIntegrationManager(
      integration as unknown as IIntegration,
    );

    if (!manager.supportsActivityPush) {
      await SyncJob.findByIdAndUpdate(jobId, {
        status: "completed",
        result: {
          success: true,
          errorMessage: `Provider ${integration.provider} has no activity endpoint, skipping`,
        },
      });
      return;
    }

    const payload = job.payload as {
      externalProjectId: string;
      activity: ActivityPushPayload;
    };

    // createdAt round-trips through Mongo as a string on some paths.
    const activity: ActivityPushPayload = {
      ...payload.activity,
      createdAt: new Date(payload.activity.createdAt),
    };

    const result = await manager.createActivity(
      payload.externalProjectId,
      activity,
    );

    if (!result.success) {
      throw new Error(result.errorMessage || "Activity push failed");
    }

    await SyncJob.findByIdAndUpdate(jobId, {
      status: "completed",
      result: {
        success: true,
        externalId: result.externalActivityId,
        rawResponse: result.rawResponse,
      },
    });

    if (job.projectId) {
      await Project.findByIdAndUpdate(job.projectId, {
        "externalMapping.lastOutboundSync": new Date(),
        "externalMapping.lastSyncError": null,
      });
    }

    await Integration.findByIdAndUpdate(integration._id, {
      lastSuccessfulSync: new Date(),
      lastError: null,
    });
  } catch (error) {
    await handleJobError(jobId, error);
  }
}

/**
 * Handle job error with retry logic.
 */
async function handleJobError(jobId: string, error: unknown): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  const job = await SyncJob.findById(jobId);
  if (!job) return;

  const attempts = (job.attempts || 0) + 1;

  if (attempts >= job.maxAttempts) {
    // Final failure
    await SyncJob.findByIdAndUpdate(jobId, {
      status: "failed",
      attempts,
      lastAttemptAt: new Date(),
      result: {
        success: false,
        errorMessage,
      },
    });

    // Update integration with error
    await Integration.findByIdAndUpdate(job.integrationId, {
      lastError: {
        message: errorMessage,
        occurredAt: new Date(),
        code: "SYNC_FAILED",
      },
    });

    // Update project with error if applicable
    if (job.projectId) {
      await Project.findByIdAndUpdate(job.projectId, {
        "externalMapping.lastSyncError": errorMessage,
      });
    }

    console.error(
      `Sync job ${jobId} failed after ${attempts} attempts: ${errorMessage}`,
    );
  } else {
    // Schedule retry
    const delay =
      RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
    const nextRetryAt = new Date(Date.now() + delay);

    await SyncJob.findByIdAndUpdate(jobId, {
      status: "pending",
      attempts,
      lastAttemptAt: new Date(),
      nextRetryAt,
    });

    // Schedule retry (simple setTimeout approach)
    setTimeout(() => {
      if (job.type === "inbound_project") {
        processInboundJob(jobId).catch(console.error);
      } else if (job.type === "outbound_photo") {
        processOutboundJob(jobId).catch(console.error);
      } else if (job.type === "outbound_activity") {
        processOutboundActivityJob(jobId).catch(console.error);
      }
    }, delay);
  }
}

/**
 * Atomically claim a webhook event for processing (idempotency).
 *
 * The insert *is* the claim: the unique {eventId, provider} index means two
 * concurrent deliveries of the same event can never both succeed, so the loser
 * gets a duplicate-key error and bows out. A read-then-write check would still
 * let both deliveries through when they land in the same tick.
 *
 * @returns true if this caller owns the event, false if it was already claimed.
 */
export async function claimWebhookEvent(
  eventId: string,
  provider: string,
): Promise<boolean> {
  try {
    await ProcessedWebhook.create({
      eventId,
      provider,
      processedAt: new Date(),
    });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return false;
    }
    throw error;
  }
}

/**
 * Release a claim so the event can be retried by a later delivery.
 * Used when the claim succeeded but enqueuing the work failed.
 */
export async function releaseWebhookEvent(
  eventId: string,
  provider: string,
): Promise<void> {
  await ProcessedWebhook.deleteOne({ eventId, provider });
}

/**
 * Process pending retry jobs (called by cron or startup).
 */
export async function processPendingRetryJobs(): Promise<void> {
  const now = new Date();

  const pendingJobs = await SyncJob.find({
    status: "pending",
    nextRetryAt: { $lte: now },
  }).limit(100);

  for (const job of pendingJobs) {
    if (job.type === "inbound_project") {
      processInboundJob(job._id.toString()).catch(console.error);
    } else if (job.type === "outbound_photo") {
      processOutboundJob(job._id.toString()).catch(console.error);
    } else if (job.type === "outbound_activity") {
      processOutboundActivityJob(job._id.toString()).catch(console.error);
    }
  }
}
