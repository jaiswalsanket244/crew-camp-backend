/**
 * Integration Manager
 *
 * Routes requests to the correct CRM provider based on integration configuration.
 * This is the main entry point for all integration operations.
 */

import { BaseProvider } from "./providers/base";
import { JobNimbusProvider } from "./providers/jobnimbus";
import { ProlineProvider } from "./providers/proline";
import { EncryptionService } from "../services/encryption";
import {
  ActivityPushPayload,
  ActivityPushResult,
  ConnectionTestResult,
  ExternalProject,
  IIntegration,
  InboundProjectData,
  IntegrationProvider,
  PhotoUploadPayload,
  PhotoUploadResult,
  TagSyncResult,
  WebhookEvent,
} from "../utils/interfaces/integrations";

// Provider class registry
// Add new providers here when implementing them
const PROVIDER_CLASSES: Record<
  IntegrationProvider,
  new (integration: IIntegration) => BaseProvider
> = {
  jobnimbus: JobNimbusProvider,
  proline: ProlineProvider,
  roofr: JobNimbusProvider, // Placeholder - implement RoofrProvider when ready
  acculynx: JobNimbusProvider, // Placeholder - implement AccuLynxProvider when ready
};

/**
 * Get provider metadata for display in UI.
 */
export const PROVIDER_INFO: Record<
  IntegrationProvider,
  {
    displayName: string;
    description: string;
    available: boolean;
  }
> = {
  jobnimbus: {
    displayName: "JobNimbus",
    description: "Sync projects and photos with JobNimbus CRM",
    available: true,
  },
  proline: {
    displayName: "Proline",
    description: "Sync projects, photos and notes with Proline CRM",
    available: true,
  },
  roofr: {
    displayName: "Roofr",
    description: "Sync projects and photos with Roofr",
    available: false, // Not yet implemented
  },
  acculynx: {
    displayName: "AccuLynx",
    description: "Sync projects and photos with AccuLynx",
    available: false, // Not yet implemented
  },
};

export class IntegrationManager {
  private provider: BaseProvider;
  private integration: IIntegration;

  constructor(integration: IIntegration) {
    this.integration = integration;
    const ProviderClass = PROVIDER_CLASSES[integration.provider];

    if (!ProviderClass) {
      throw new Error(`Unknown provider: ${integration.provider}`);
    }

    // Decrypt credentials before passing to provider
    const decryptedIntegration = {
      ...integration,
      credentials: {
        ...integration.credentials,
        apiKey: EncryptionService.decrypt(integration.credentials.apiKey),
      },
    };

    this.provider = new ProviderClass(decryptedIntegration as IIntegration);
  }

  /**
   * Test if the integration credentials are valid.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    return this.provider.testConnection();
  }

  /**
   * Parse a webhook event from the CRM.
   */
  parseWebhook(
    headers: Record<string, string>,
    body: unknown,
  ): WebhookEvent | null {
    return this.provider.parseWebhook(headers, body);
  }

  /**
   * Whether this provider owns its own inbound payload mapping.
   * When false, the sync service applies the legacy JobNimbus-shaped mapping.
   */
  get supportsInboundNormalization(): boolean {
    return typeof this.provider.normalizeInboundPayload === "function";
  }

  /**
   * Normalize a raw inbound webhook payload into CrewCam project fields.
   * Returns null when the provider has no normalizer or skips the payload.
   */
  async normalizeInboundPayload(
    payload: Record<string, unknown>,
  ): Promise<InboundProjectData | null> {
    if (!this.provider.normalizeInboundPayload) {
      return null;
    }
    return this.provider.normalizeInboundPayload(payload);
  }

  /**
   * Verify webhook signature.
   */
  verifyWebhookSignature(
    headers: Record<string, string>,
    body: unknown,
  ): boolean {
    return this.provider.verifyWebhookSignature(
      headers,
      body,
      this.integration.webhookSecret,
    );
  }

  /**
   * Fetch project details from the CRM.
   */
  async getProject(externalId: string): Promise<ExternalProject | null> {
    return this.provider.getProject(externalId);
  }

  /**
   * Upload a photo to the CRM.
   */
  async uploadPhoto(
    externalProjectId: string,
    photo: PhotoUploadPayload,
  ): Promise<PhotoUploadResult> {
    return this.provider.uploadPhoto(externalProjectId, photo);
  }

  /**
   * Whether this provider can mirror a post's note onto the CRM timeline.
   */
  get supportsActivityPush(): boolean {
    return typeof this.provider.createActivity === "function";
  }

  /**
   * Push a post's note to the CRM as an activity/note.
   */
  async createActivity(
    externalProjectId: string,
    activity: ActivityPushPayload,
  ): Promise<ActivityPushResult> {
    if (!this.provider.createActivity) {
      return {
        success: false,
        errorMessage: `${this.provider.providerName} has no activity endpoint`,
      };
    }
    return this.provider.createActivity(externalProjectId, activity);
  }

  /**
   * Whether this provider can register tag names in the CRM's vocabulary.
   */
  get supportsTagSync(): boolean {
    return typeof this.provider.syncTagDefinitions === "function";
  }

  /**
   * Ensure the given tag names exist in the CRM's tag vocabulary.
   */
  async syncTagDefinitions(tagNames: string[]): Promise<TagSyncResult> {
    if (!this.provider.syncTagDefinitions) {
      return {
        success: false,
        errorMessage: `${this.provider.providerName} has no tag endpoint`,
      };
    }
    return this.provider.syncTagDefinitions(tagNames);
  }

  /**
   * Get the external URL for a project.
   */
  getProjectUrl(externalId: string): string {
    return this.provider.getProjectUrl(externalId);
  }

  /**
   * Get the provider name.
   */
  get providerName(): string {
    return this.provider.providerName;
  }

  /**
   * Get the display name.
   */
  get displayName(): string {
    return this.provider.displayName;
  }
}

/**
 * Create an IntegrationManager for a given integration.
 */
export function createIntegrationManager(
  integration: IIntegration,
): IntegrationManager {
  return new IntegrationManager(integration);
}

/**
 * Check if a provider is available for use.
 */
export function isProviderAvailable(provider: IntegrationProvider): boolean {
  return PROVIDER_INFO[provider]?.available ?? false;
}

/**
 * Get list of all available providers.
 */
export function getAvailableProviders(): IntegrationProvider[] {
  return (Object.keys(PROVIDER_INFO) as IntegrationProvider[]).filter(
    (provider) => PROVIDER_INFO[provider].available,
  );
}
