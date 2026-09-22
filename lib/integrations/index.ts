/**
 * CRM Integrations Module
 *
 * This module provides integration with external CRM systems like JobNimbus,
 * enabling automatic project sync and photo upload.
 *
 * Usage:
 * - Integration routes are mounted at /api/integrations
 * - Webhook handlers are at /webhook/{provider}
 *   (e.g., /webhook/jobnimbus, /webhook/proline)
 * - Hooks are called from post/file creation to trigger outbound sync
 *
 * To add a new CRM provider:
 * 1. Create provider class in providers/ extending BaseProvider
 * 2. Register in manager.ts PROVIDER_CLASSES and PROVIDER_INFO
 * 3. Add webhook route in routes/webhooks/index.ts
 * 4. Add provider to INTEGRATION_PROVIDERS enum in utils/enums/integrations
 * 5. Implement normalizeInboundPayload if the CRM's webhook payload isn't
 *    JobNimbus-shaped (see providers/proline.ts)
 */

// Types
export * from "../utils/interfaces/integrations";

// Manager
export {
  IntegrationManager,
  createIntegrationManager,
  PROVIDER_INFO,
  isProviderAvailable,
  getAvailableProviders,
} from "./manager";

// Sync Service
export {
  createInboundSyncJob,
  createOutboundSyncJob,
  createOutboundActivityJob,
  claimWebhookEvent,
  releaseWebhookEvent,
  processPendingRetryJobs,
  enqueueOutboundPhotoJobs,
  reclaimStuckOutboundJobs,
} from "./syncService";

// Missed photo backfill (cron)
export { backfillMissedPhotoSyncs } from "./photoBackfill";

// Hooks
export {
  onPostCreated,
  onFileUploaded,
  onProjectCreated,
  onProjectUpdated,
} from "./hooks";

// Webhook helpers
export { syncTagsToProject } from "./webhookHelpers";

// Providers (for direct access if needed)
export { BaseProvider } from "./providers/base";
export { JobNimbusProvider } from "./providers/jobnimbus";
export { ProlineProvider } from "./providers/proline";
