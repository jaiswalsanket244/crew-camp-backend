/**
 * Webhook Helper Functions
 *
 * Utilities for processing inbound webhook data from CRM systems.
 */

import { createHash } from "crypto";
import mongoose from "mongoose";
import { Tags, Project } from "../db";
import { CURRENT_TAGS, TAGS_FOR } from "../utils/enums/enums";

/**
 * Stable JSON encoding — key order can't influence the hash.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Build the idempotency key for one inbound webhook delivery.
 *
 * The provider's event id alone isn't enough for JobNimbus: it sends the record
 * id (jnid), not a per-delivery id, so keying on it alone would suppress every
 * later legitimate update to that record for the ProcessedWebhook TTL. Folding
 * in a payload hash collapses byte-identical redeliveries — the duplicate-project
 * case — while letting real changes through.
 */
export function buildWebhookEventKey(
  eventId: string,
  payload: Record<string, unknown>,
): string {
  const hash = createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex")
    .slice(0, 32);
  return `${eventId}:${hash}`;
}

/**
 * Sync tags from JobNimbus to CrewCam project.
 * Creates tags if they don't exist, then assigns them to the project.
 *
 * @param projectId - CrewCam project ID
 * @param tagNames - Array of tag names from JobNimbus (e.g., ["Active", "Completed"])
 * @param companyId - Company ID for tag creation
 * @returns Array of tag IDs that were assigned
 */
export async function syncTagsToProject(
  projectId: mongoose.Types.ObjectId | string,
  tagNames: string[],
  companyId: mongoose.Types.ObjectId | string,
): Promise<mongoose.Types.ObjectId[]> {
  if (!tagNames || tagNames.length === 0) {
    return [];
  }

  const tagIds: mongoose.Types.ObjectId[] = [];

  for (const tagName of tagNames) {
    // Skip empty tag names
    if (!tagName || tagName.trim() === "") {
      continue;
    }

    // Find or create the tag
    // Priority: 1) Company-specific tag, 2) Default tag with same name
    let tag = await Tags.findOne({
      tag: tagName,
      tagFor: TAGS_FOR.PROJECT,
      $or: [
        { companyId: companyId, type: CURRENT_TAGS.CUSTOM },
        { type: CURRENT_TAGS.DEFAULT, companyId: { $exists: false } },
      ],
    });

    if (!tag) {
      // Create new tag if it doesn't exist
      tag = await Tags.create({
        tag: tagName,
        companyId: companyId,
        type: CURRENT_TAGS.CUSTOM, // Default type
        tagFor: TAGS_FOR.PROJECT, // Tag is for projects
        color: generateTagColor(tagName), // Generate a color based on tag name
      });
    }

    tagIds.push(tag._id);
  }

  // Update project with the tag IDs
  if (tagIds.length > 0) {
    await Project.findByIdAndUpdate(projectId, {
      $addToSet: { tags: { $each: tagIds } }, // Add tags without duplicates
    });
  }

  return tagIds;
}

/**
 * Generate a consistent color for a tag name.
 * Uses a simple hash to ensure the same tag always gets the same color.
 */
function generateTagColor(tagName: string): string {
  const colors = [
    "#FF6B6B", // Red
    "#4ECDC4", // Teal
    "#45B7D1", // Blue
    "#FFA07A", // Salmon
    "#98D8C8", // Mint
    "#F7DC6F", // Yellow
    "#BB8FCE", // Purple
    "#85C1E2", // Light Blue
    "#F8B739", // Orange
    "#52B788", // Green
  ];

  // Simple hash function to get consistent color per tag name
  let hash = 0;
  for (let i = 0; i < tagName.length; i++) {
    hash = tagName.charCodeAt(i) + ((hash << 5) - hash);
  }

  return colors[Math.abs(hash) % colors.length];
}

export async function getTagIdsToPosts(
  tagNames: string[],
  companyId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId[]> {
  if (!tagNames || tagNames.length === 0) {
    return [];
  }

  const tagIds: mongoose.Types.ObjectId[] = [];

  for (const tagName of tagNames) {
    // Skip empty tag names
    if (!tagName || tagName.trim() === "") {
      continue;
    }

    // Find or create the tag
    // Priority: 1) Company-specific tag, 2) Default tag with same name
    let tag = await Tags.findOne({
      tag: tagName,
      tagFor: TAGS_FOR.POST,
      $or: [
        { companyId: companyId, type: CURRENT_TAGS.CUSTOM },
        { type: CURRENT_TAGS.DEFAULT, companyId: { $exists: false } },
      ],
    });

    if (!tag) {
      // Create new tag if it doesn't exist
      tag = await Tags.create({
        tag: tagName,
        companyId: companyId,
        type: CURRENT_TAGS.CUSTOM, // Default type
        tagFor: TAGS_FOR.POST, // Tag is for posts
        color: generateTagColor(tagName), // Generate a color based on tag name
      });
    }

    tagIds.push(tag._id);
  }

  return tagIds;
}
