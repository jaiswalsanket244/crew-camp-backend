/**
 * Missed Photo Backfill
 *
 * Safety net for the outbound photo sync. The onPostCreated / onFileUploaded
 * hooks are fire-and-forget, so a photo silently never reaches the CRM when the
 * hook throws, the server restarts mid-upload, the post is created through a
 * path that doesn't call the hook, or the integration was connected after the
 * photo was uploaded.
 *
 * This scans a recent window of media in integration-linked projects, finds the
 * ones with no outbound_photo sync job at all, and queues them. Jobs that
 * already exist are left alone — including failed ones, which exhausted their
 * retries deliberately.
 */

import {
  Files,
  Integration,
  PostFiles,
  Project,
  SyncJob,
  Tags,
  User,
} from "../db";
import {
  enqueueOutboundPhotoJobs,
  reclaimStuckOutboundJobs,
} from "./syncService";
import {
  OutboundPhotoJobInput,
  PhotoBackfillSummary,
} from "../utils/interfaces/integrations";
import { getFileName, getMimeType } from "./hooks/postHooks";
import { CURRENT_STATUS } from "../utils/enums/enums";
import { config } from "../utils/configuration/config";
import { Types } from "mongoose";

// Only media newer than this is considered. Also bounds retries: a photo the
// CRM keeps rejecting drops out of scope after a week instead of being requeued
// forever.
const LOOKBACK_DAYS = 7;

// Per-integration ceiling on how much media one run inspects. Hitting it is
// reported in the summary so a truncated scan never reads as full coverage.
const CANDIDATE_SCAN_LIMIT = 5000;

// Per-integration ceiling on jobs queued per run, so a newly connected
// integration doesn't dump thousands of uploads onto the CRM at once.
const MAX_JOBS_PER_INTEGRATION = 200;

// A job still `processing` after this long lost its worker to a restart.
const STUCK_PROCESSING_MINUTES = 30;

interface LinkedProject {
  _id: Types.ObjectId;
  name: string;
  externalId: string;
}

interface CandidateMedia {
  projectId: Types.ObjectId;
  userId?: Types.ObjectId;
  url: string;
  fileType?: string;
  fileName?: string;
  tags?: Types.ObjectId[];
  postId?: Types.ObjectId;
  uploadedAt: Date;
}

/**
 * Projects of this company that are mapped to the integration's CRM.
 */
async function getLinkedProjects(
  companyId: Types.ObjectId,
  provider: string,
): Promise<LinkedProject[]> {
  const projects = await Project.find(
    {
      companyId,
      "externalMapping.system": provider,
      "externalMapping.externalId": { $type: "string" },
      archivedAt: { $exists: false },
    },
    { name: 1, "externalMapping.externalId": 1 },
  ).lean();

  return projects.map((project) => ({
    _id: project._id,
    name: project.name,
    externalId: project.externalMapping!.externalId as string,
  }));
}

/**
 * File URLs that already have an outbound_photo job of any status.
 * Jobs are always created after their file, so the same cutoff applies.
 */
async function getAlreadyQueuedUrls(
  projectIds: Types.ObjectId[],
  cutoff: Date,
): Promise<Set<string>> {
  const jobs = await SyncJob.find(
    {
      type: "outbound_photo",
      projectId: { $in: projectIds },
      createdAt: { $gte: cutoff },
    },
    { "payload.photo.fileUrl": 1 },
  ).lean();

  const urls = new Set<string>();
  for (const job of jobs) {
    const fileUrl = (job.payload as { photo?: { fileUrl?: string } })?.photo
      ?.fileUrl;
    if (fileUrl) urls.add(fileUrl);
  }
  return urls;
}

/**
 * Resolve uploader display names and tag labels for a batch in two queries,
 * rather than one lookup per photo.
 */
async function buildLookups(candidates: CandidateMedia[]) {
  const userIds = new Set<string>();
  const tagIds = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.userId) userIds.add(candidate.userId.toString());
    for (const tagId of candidate.tags || []) tagIds.add(tagId.toString());
  }

  const [users, tags] = await Promise.all([
    userIds.size
      ? User.find({ _id: { $in: Array.from(userIds) } }, { name: 1 }).lean()
      : [],
    tagIds.size
      ? Tags.find({ _id: { $in: Array.from(tagIds) } }, { tag: 1 }).lean()
      : [],
  ]);

  const userNames = new Map<string, string>();
  for (const user of users) {
    const name = `${user.name?.first || ""} ${user.name?.last || ""}`.trim();
    userNames.set(user._id.toString(), name || "Unknown User");
  }

  const tagNames = new Map<string, string>();
  for (const tag of tags) {
    if (tag.tag) tagNames.set(tag._id.toString(), tag.tag);
  }

  return { userNames, tagNames };
}

/**
 * Backfill one integration. Returns what it queued and whether the scan was
 * truncated by CANDIDATE_SCAN_LIMIT.
 */
async function backfillIntegration(
  integrationId: Types.ObjectId,
  companyId: Types.ObjectId,
  provider: string,
  cutoff: Date,
): Promise<{ postFiles: number; projectFiles: number; truncated: boolean }> {
  const projects = await getLinkedProjects(companyId, provider);

  if (!projects.length) {
    console.log(" iam faled");
    return { postFiles: 0, projectFiles: 0, truncated: false };
  }

  const projectIds = projects.map((project) => project._id);
  const projectById = new Map(
    projects.map((project) => [project._id.toString(), project]),
  );

  const [postFiles, projectFiles, queuedUrls] = await Promise.all([
    PostFiles.find(
      {
        projectId: { $in: projectIds },
        status: CURRENT_STATUS.ACTIVE,
        createdAt: { $gte: cutoff },
        url: { $type: "string" },
      },
      {
        projectId: 1,
        userId: 1,
        postId: 1,
        url: 1,
        fileType: 1,
        tags: 1,
        createdAt: 1,
      },
    )
      .sort({ createdAt: 1 })
      .limit(CANDIDATE_SCAN_LIMIT)
      .lean(),
    Files.find(
      {
        projectId: { $in: projectIds },
        status: CURRENT_STATUS.ACTIVE,
        createdAt: { $gte: cutoff },
      },
      { projectId: 1, userId: 1, url: 1, fileType: 1, name: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .limit(CANDIDATE_SCAN_LIMIT)
      .lean(),
    getAlreadyQueuedUrls(projectIds, cutoff),
  ]);

  const truncated =
    postFiles.length >= CANDIDATE_SCAN_LIMIT ||
    projectFiles.length >= CANDIDATE_SCAN_LIMIT;

  const postCandidates: CandidateMedia[] = postFiles
    .filter((file) => file.url && !queuedUrls.has(file.url))
    .map((file) => ({
      projectId: file.projectId,
      userId: file.userId,
      postId: file.postId,
      url: file.url as string,
      fileType: file.fileType,
      tags: file.tags,
      uploadedAt: file.createdAt || new Date(),
    }));

  const fileCandidates: CandidateMedia[] = projectFiles
    .filter((file) => file.url && !queuedUrls.has(file.url))
    .map((file) => ({
      projectId: file.projectId,
      userId: file.userId,
      url: file.url,
      fileType: file.fileType,
      fileName: file.name,
      uploadedAt: file.createdAt || new Date(),
    }));

  // Post photos first — they're the primary sync target, so they win the budget
  // when both kinds are backed up.
  const candidates = [...postCandidates, ...fileCandidates].slice(
    0,
    MAX_JOBS_PER_INTEGRATION,
  );
  if (!candidates.length) {
    return { postFiles: 0, projectFiles: 0, truncated };
  }

  const { userNames, tagNames } = await buildLookups(candidates);

  const jobs: OutboundPhotoJobInput[] = [];
  let queuedPostFiles = 0;
  let queuedProjectFiles = 0;

  for (const candidate of candidates) {
    const project = projectById.get(candidate.projectId.toString());
    if (!project) continue;

    const resolvedTags = (candidate.tags || [])
      .map((tagId) => tagNames.get(tagId.toString()))
      .filter((tag): tag is string => !!tag);

    jobs.push({
      integrationId,
      projectId: project._id,
      externalProjectId: project.externalId,
      photo: {
        fileUrl: candidate.url,
        fileName: getFileName({
          url: candidate.url,
          fileName: candidate.fileName,
          fileType: candidate.fileType,
        }),
        mimeType: getMimeType({
          url: candidate.url,
          fileName: candidate.fileName,
          fileType: candidate.fileType,
        }),
        uploadedBy: candidate.userId
          ? userNames.get(candidate.userId.toString()) || "Unknown User"
          : "Unknown User",
        uploadedAt: candidate.uploadedAt,
        projectName: project.name,
        projectUrl: `${config.WEB_URL}/projects/${project._id}`,
        postUrl: candidate.postId
          ? `${config.WEB_URL}/Postscreen?postId=${candidate.postId}`
          : undefined,
        tags: resolvedTags.length ? resolvedTags : undefined,
      },
    });

    if (candidate.postId) queuedPostFiles++;
    else queuedProjectFiles++;
  }

  await enqueueOutboundPhotoJobs(jobs);

  return {
    postFiles: queuedPostFiles,
    projectFiles: queuedProjectFiles,
    truncated,
  };
}

/**
 * Entry point for the cron. Never throws — one bad integration is recorded in
 * the summary and the rest still run.
 */
export async function backfillMissedPhotoSyncs(): Promise<PhotoBackfillSummary> {
  const startedAt = Date.now();
  const cutoff = new Date(startedAt - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const summary: PhotoBackfillSummary = {
    integrationsScanned: 0,
    reclaimedStuckJobs: 0,
    postFilesEnqueued: 0,
    projectFilesEnqueued: 0,
    truncatedIntegrations: [],
    failures: [],
    durationMs: 0,
  };

  try {
    summary.reclaimedStuckJobs = await reclaimStuckOutboundJobs(
      STUCK_PROCESSING_MINUTES,
    );
  } catch (error) {
    summary.failures.push({
      integrationId: "stuck-job-reclaim",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const integrations = await Integration.find(
    {
      status: "connected",
      "settings.outboundSyncEnabled": true,
    },
    { companyId: 1, provider: 1 },
  ).lean();

  for (const integration of integrations) {
    summary.integrationsScanned++;
    try {
      const result = await backfillIntegration(
        integration._id,
        integration.companyId,
        integration.provider,
        cutoff,
      );
      summary.postFilesEnqueued += result.postFiles;
      summary.projectFilesEnqueued += result.projectFiles;
      if (result.truncated) {
        summary.truncatedIntegrations.push(integration._id.toString());
      }
    } catch (error) {
      summary.failures.push({
        integrationId: integration._id.toString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}
