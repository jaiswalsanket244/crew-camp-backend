/**
 * Shared types for CRM integrations.
 * All providers use these standardized interfaces.
 */

import { INTEGRATION_PROVIDERS } from "../../enums/integrations";
import { ObjectIdType } from "../schemaInterface";

// Standardized external project representation
export interface ExternalProject {
  externalId: string;
  externalUrl: string;
  name: string;
  address?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  rawData: Record<string, unknown>;
}

// An external project after geocoding, ready to be written to a CrewCam project
export interface InboundProjectData extends ExternalProject {
  coordinates?: { latitude?: number; longitude?: number };
  projectType?: string;
  // Set by providers implementing normalizeInboundPayload. The legacy JobNimbus
  // path leaves these undefined and derives the equivalents from rawData.
  description?: string;
  tags?: string[];
}

// Photo data for outbound sync
export interface PhotoUploadPayload {
  fileUrl: string;
  fileName: string;
  mimeType: string;
  uploadedBy: string;
  uploadedAt: Date;
  projectName: string;
  projectUrl: string;
  postUrl?: string;
  tags?: string[];
}

// One outbound_photo sync job waiting to be queued (used by bulk enqueue paths)
export interface OutboundPhotoJobInput {
  integrationId: ObjectIdType;
  projectId: ObjectIdType;
  externalProjectId: string;
  photo: PhotoUploadPayload;
}

// Per-run tally emitted by the missed-photo backfill cron
export interface PhotoBackfillSummary {
  integrationsScanned: number;
  reclaimedStuckJobs: number;
  postFilesEnqueued: number;
  projectFilesEnqueued: number;
  truncatedIntegrations: string[];
  failures: { integrationId: string; message: string }[];
  durationMs: number;
}

// One CrewCam post's text, pushed to the CRM as an activity/note.
export interface ActivityPushPayload {
  // The post's note/caption — the actual body of the activity.
  text: string;
  authorName: string;
  createdAt: Date;
  projectName: string;
  projectUrl: string;
  postUrl?: string;
  fileCount?: number;
  tags?: string[];
}

// Result of pushing an activity to the CRM
export interface ActivityPushResult {
  success: boolean;
  externalActivityId?: string;
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
}

// One outbound_activity sync job waiting to be queued
export interface OutboundActivityJobInput {
  integrationId: ObjectIdType;
  projectId: ObjectIdType;
  externalProjectId: string;
  activity: ActivityPushPayload;
}

// Result of pushing tag definitions to the CRM
export interface TagSyncResult {
  success: boolean;
  // Tag names accepted by the CRM's vocabulary.
  syncedTags?: string[];
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
}

// Result of photo upload to CRM
export interface PhotoUploadResult {
  success: boolean;
  externalAttachmentId?: string;
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
}

// Result of connection test
export interface ConnectionTestResult {
  success: boolean;
  accountName?: string;
  errorMessage?: string;
}

// Payload for creating a project in external CRM
export interface CreateProjectPayload {
  _id: string;
  name: string;
  description?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  customer?: {
    contactId?: string; // External contact ID if known
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
  status?: string;
  geo?: {
    lat?: number;
    lon?: number;
  };
  tags?: string[]; // Array of tag names
  customFields?: Record<string, unknown>;
}

// Result of project creation
export interface CreateProjectResult {
  success: boolean;
  externalId?: string;
  externalUrl?: string;
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
}

// Payload for updating a project in external CRM
export interface UpdateProjectPayload {
  externalId: string; // Required: the external CRM's project ID
  name?: string;
  description?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  customer?: {
    contactId?: string; // External contact ID if known
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
  status?: string;
  geo?: {
    lat?: number;
    lon?: number;
  };
  tags?: string[]; // Array of tag names
  customFields?: Record<string, unknown>;
  is_archived: boolean;
}

// Result of project update
export interface UpdateProjectResult {
  success: boolean;
  externalId?: string;
  externalUrl?: string;
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
}

// Parsed webhook event
export interface WebhookEvent {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

// Provider configuration for registration
export interface ProviderConfig {
  name: INTEGRATION_PROVIDERS;
  displayName: string;
  description: string;
  docsUrl?: string;
}
