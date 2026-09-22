/**
 * Base provider class for CRM integrations.
 *
 * All CRM providers (JobNimbus, Roofr, AccuLynx) extend this class
 * and implement the abstract methods.
 *
 * To add a new CRM:
 * 1. Create a new file in providers/ (e.g., roofr.ts)
 * 2. Extend BaseProvider
 * 3. Implement all abstract methods
 * 4. Register in manager.ts
 */

import {
  ActivityPushPayload,
  ActivityPushResult,
  ExternalProject,
  InboundProjectData,
  PhotoUploadPayload,
  TagSyncResult,
  PhotoUploadResult,
  ConnectionTestResult,
  WebhookEvent,
  CreateProjectPayload,
  CreateProjectResult,
  UpdateProjectPayload,
  UpdateProjectResult,
  IIntegration,
} from "../../utils/interfaces/integrations";

export abstract class BaseProvider {
  protected integration: IIntegration;

  constructor(integration: IIntegration) {
    this.integration = integration;
  }

  /** Provider identifier (e.g., "jobnimbus") */
  abstract readonly providerName: string;

  /** Human-readable name (e.g., "JobNimbus") */
  abstract readonly displayName: string;

  /** Base URL for API calls */
  abstract readonly apiBaseUrl: string;

  /**
   * Test if credentials are valid.
   * Called when user connects integration.
   */
  abstract testConnection(): Promise<ConnectionTestResult>;

  /**
   * Parse incoming webhook into standardized format.
   * Return null if event should be ignored.
   */
  abstract parseWebhook(
    headers: Record<string, string>,
    body: unknown,
  ): WebhookEvent | null;

  /**
   * Verify webhook signature.
   * Return false to reject the webhook.
   */
  abstract verifyWebhookSignature(
    headers: Record<string, string>,
    body: unknown,
    secret: string,
  ): boolean;

  /**
   * Fetch project/job details from CRM.
   * Used during inbound sync.
   */
  abstract getProject(externalId: string): Promise<ExternalProject | null>;

  /**
   * Upload photo to CRM project.
   * Used during outbound sync.
   */
  abstract uploadPhoto(
    externalProjectId: string,
    photo: PhotoUploadPayload,
  ): Promise<PhotoUploadResult>;

  /**
   * Normalize a raw inbound webhook payload into CrewCam project fields.
   *
   * Optional. Providers that implement this own their own payload mapping
   * (naming, address, contact, tags) and the sync service uses it verbatim;
   * providers that don't fall back to the legacy JobNimbus-shaped mapping in
   * syncService. Return null to skip the payload.
   */
  normalizeInboundPayload?(
    payload: Record<string, unknown>,
  ): Promise<InboundProjectData | null>;

  /**
   * Push a CrewCam post's text to the CRM as an activity/note.
   *
   * Optional — implemented by providers whose API has a project-scoped
   * activity or note endpoint. Photos travel separately via uploadPhoto.
   */
  createActivity?(
    externalProjectId: string,
    activity: ActivityPushPayload,
  ): Promise<ActivityPushResult>;

  /**
   * Ensure the given tag names exist in the CRM's tag vocabulary.
   *
   * Optional. Note this registers tag *definitions*; attaching them to a
   * specific record is provider-specific and may require CRM-side tag IDs.
   */
  syncTagDefinitions?(tagNames: string[]): Promise<TagSyncResult>;

  /**
   * Create a new project/job in CRM.
   * Optional method - providers can implement if they support project creation.
   */
  createProject?(project: CreateProjectPayload): Promise<CreateProjectResult>;

  /**
   * Update an existing project/job in CRM.
   * Optional method - providers can implement if they support project updates.
   */
  updateProject?(project: UpdateProjectPayload): Promise<UpdateProjectResult>;

  /**
   * Generate the external URL for a project/job.
   */
  abstract getProjectUrl(externalId: string): string;

  // ─────────────────────────────────────────────────────────
  // Shared utilities (inherited by all providers)
  // ─────────────────────────────────────────────────────────

  /**
   * Get authorization headers for API requests.
   */
  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.integration.credentials.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Make an authenticated API request.
   */
  protected async makeRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    data?: unknown,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${endpoint}`;

    const options: RequestInit = {
      method,
      headers: this.getAuthHeaders(),
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${this.providerName} API error: ${response.status} - ${errorText}`,
      );
    }

    return response.json();
  }

  /**
   * Download a file from URL and return as Buffer.
   */
  protected async downloadFile(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file from ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
