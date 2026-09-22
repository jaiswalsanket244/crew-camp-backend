/**
 * Post-related Integration Hooks
 *
 * Functions to hook into post/photo operations and trigger sync.
 * These are called from existing routes/helpers after successful operations.
 */

import mongoose from "mongoose";
import { Integration, Project } from "../../db";
import {
  createOutboundActivityJob,
  createOutboundSyncJob,
} from "../syncService";
import {
  ActivityPushPayload,
  IIntegration,
  PhotoUploadPayload,
} from "../../utils/interfaces/integrations";
import { createIntegrationManager } from "../manager";
import { config } from "../../utils/configuration/config";

export interface PostFile {
  url: string;
  fileType?: string; // MIME type (e.g., "image/jpeg", "video/mp4")
  fileName?: string; // Optional custom filename
  name?: string; // Alternative filename field
  mimeType?: string; // Alternative MIME type field
  type?: string; // Alternative type field
  tags?: mongoose.Types.ObjectId[];
}

interface PostData {
  _id: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  files: PostFile[];
  createdAt: Date;
  // The post's caption. Mirrored to the CRM timeline by providers with an
  // activity endpoint (currently Proline).
  note?: string;
}

interface UserData {
  _id: mongoose.Types.ObjectId;
  fullName?: string;
  name?: {
    first?: string;
    last?: string;
  };
}

interface TagData {
  _id: mongoose.Types.ObjectId;
  name: string;
}

/**
 * Helper: Extract filename from URL or use provided name
 */
export function getFileName(file: PostFile): string {
  // Priority: fileName > name > extract from URL
  if (file.fileName) return file.fileName;
  if (file.name) return file.name;

  // Extract filename from URL
  try {
    const url = new URL(file.url);
    const pathname = url.pathname;
    const filename = pathname.split("/").pop() || "file";
    return filename;
  } catch {
    // If URL parsing fails, use generic name based on MIME type
    const mimeType =
      file.fileType || file.mimeType || file.type || "application/octet-stream";
    if (mimeType.startsWith("image/")) return `image.${mimeType.split("/")[1]}`;
    if (mimeType.startsWith("video/")) return `video.${mimeType.split("/")[1]}`;
    return "file";
  }
}

/**
 * Helper: Get MIME type from file
 */
export function getMimeType(file: PostFile): string {
  // Priority: fileType > mimeType > type > infer from URL
  if (file.fileType) return file.fileType;
  if (file.mimeType) return file.mimeType;
  if (file.type) return file.type;

  // Try to infer from filename
  const filename = file.fileName || file.name || file.url;
  const ext = filename.split(".").pop()?.toLowerCase();

  // Common MIME types
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    webm: "video/webm",
    pdf: "application/pdf",
  };

  return mimeTypes[ext || ""] || "application/octet-stream";
}

/**
 * Hook called after a post (with photos) is created.
 *
 * Queues one outbound photo job per file, plus — for providers with an activity
 * endpoint — a single activity job carrying the post's note, so the caption
 * isn't repeated once per photo.
 *
 * @param post - The created post document
 * @param user - The user who created the post
 * @param tags - Optional array of tag documents for the photos
 */
export async function onPostCreated(
  post: PostData,
  user: UserData,
  tags?: TagData[],
): Promise<void> {
  try {
    // Find project with external mapping
    const project = await Project.findById(post.projectId);
    if (!project) {
      return;
    }

    // Check if project has external mapping
    if (
      !project.externalMapping?.system ||
      !project.externalMapping?.externalId
    ) {
      return;
    }

    // Find active integration for this workspace and provider
    const integration = await Integration.findOne({
      companyId: project.companyId,
      provider: project.externalMapping.system,
      status: "connected",
      "settings.outboundSyncEnabled": true,
    });

    if (!integration) {
      return;
    }

    // Get user's display name
    const uploaderName =
      user.fullName ||
      (user.name
        ? `${user.name.first || ""} ${user.name.last || ""}`.trim()
        : "Unknown User");

    // Create tag name lookup
    const tagMap = new Map<string, string>();
    if (tags) {
      tags.forEach((tag) => {
        tagMap.set(tag._id.toString(), tag.name);
      });
    }

    // Create sync jobs for each file
    for (const file of post.files) {
      // Get tag names for this file
      const fileTags: string[] = [];
      if (file.tags) {
        for (const tagId of file.tags) {
          const tagName = tagMap.get(tagId.toString());
          if (tagName) {
            fileTags.push(tagName);
          }
        }
      }

      const photoPayload: PhotoUploadPayload = {
        fileUrl: file.url,
        fileName: getFileName(file),
        mimeType: getMimeType(file),
        uploadedBy: uploaderName,
        uploadedAt: post.createdAt || new Date(),
        projectName: project.name,
        projectUrl: `${config.WEB_URL}/projects/${project._id}`,
        postUrl: `${config.WEB_URL}/Postscreen?postId=${post._id}`,
        tags: fileTags.length > 0 ? fileTags : undefined,
      };

      // Create outbound sync job (async, doesn't block)
      await createOutboundSyncJob(
        integration._id,
        project._id,
        project.externalMapping.externalId,
        photoPayload,
      );
    }

    // Mirror the post's note onto the CRM timeline, once per post. Proline's
    // file endpoint carries no description field, so the caption would be lost
    // entirely without this.
    const note = post.note?.trim();
    if (note) {
      const manager = createIntegrationManager(
        integration as unknown as IIntegration,
      );

      if (manager.supportsActivityPush) {
        const activityPayload: ActivityPushPayload = {
          text: note,
          authorName: uploaderName,
          createdAt: post.createdAt || new Date(),
          projectName: project.name,
          projectUrl: `${config.WEB_URL}/projects/${project._id}`,
          postUrl: `${config.WEB_URL}/Postscreen?postId=${post._id}`,
          fileCount: post.files?.length || 0,
          tags: tags?.length ? tags.map((tag) => tag.name) : undefined,
        };

        await createOutboundActivityJob(
          integration._id,
          project._id,
          project.externalMapping.externalId,
          activityPayload,
        );
      }
    }
  } catch (error) {
    console.log("Error in onPostCreated hook:", error);
    // Log error but don't throw - integration failures shouldn't block core operations
  }
}

/**
 * Hook called after a single file is uploaded (e.g., gallery upload).
 * Triggers outbound sync for the file.
 *
 * @param projectId - The project ID
 * @param file - The uploaded file
 * @param user - The user who uploaded the file
 * @param tagNames - Optional array of tag names
 */
export async function onFileUploaded(
  projectId: mongoose.Types.ObjectId | string,
  file: PostFile,
  user: UserData,
  tagNames?: string[],
): Promise<void> {
  try {
    // Find project with external mapping
    const project = await Project.findById(projectId);
    if (!project) {
      return;
    }

    // Check if project has external mapping
    if (
      !project.externalMapping?.system ||
      !project.externalMapping?.externalId
    ) {
      return;
    }

    // Find active integration for this workspace and provider
    const integration = await Integration.findOne({
      companyId: project.companyId,
      provider: project.externalMapping.system,
      status: "connected",
      "settings.outboundSyncEnabled": true,
    });

    if (!integration) {
      return;
    }

    // Get user's display name
    const uploaderName =
      user.fullName ||
      (user.name
        ? `${user.name.first || ""} ${user.name.last || ""}`.trim()
        : "Unknown User");

    const photoPayload: PhotoUploadPayload = {
      fileUrl: file.url,
      fileName: getFileName(file),
      mimeType: getMimeType(file),
      uploadedBy: uploaderName,
      uploadedAt: new Date(),
      projectName: project.name,
      projectUrl: `${config.WEB_URL}/projects/${project._id}`,
      tags: tagNames,
    };

    // Create outbound sync job (async, doesn't block)
    await createOutboundSyncJob(
      integration._id,
      project._id,
      project.externalMapping.externalId,
      photoPayload,
    );
  } catch (error) {
    // Log error but don't throw - integration failures shouldn't block core operations
  }
}
