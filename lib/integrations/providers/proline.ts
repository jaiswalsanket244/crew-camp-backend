/**
 * Proline CRM integration provider.
 *
 * Inbound: Proline posts a flat project payload to
 *   POST /webhook/proline?secret=<integration.webhookSecret>
 * on project create and update. There is no event-type field and no
 * created-vs-updated distinction, so every delivery is treated as an upsert
 * keyed on `project_id`.
 *
 * Outbound (Partner API, https://docs.proline.app/partner-api):
 *   - photos  -> POST /v1/files/create_project_file
 *   - notes   -> POST /v1/activity/create_alert
 *   - tags    -> POST /v1/import/tags  (vocabulary) and
 *                POST /v1/edit/project (attach, by Proline tag ID)
 *
 * Auth is two headers, not a bearer token: PARTNER_KEY is our partner-wide
 * token from config, COMPANY_KEY is the per-company token the customer copies
 * from their Proline integrations page (stored as the integration's apiKey).
 * The company token is what Proline rate-limits on.
 *
 * Hosts are env-configurable (PROLINE_APP_URL / PROLINE_API_URL) because
 * Proline's app host differs per deployment.
 */

import { BaseProvider } from "./base";
import {
  ActivityPushPayload,
  ActivityPushResult,
  ExternalProject,
  InboundProjectData,
  PhotoUploadPayload,
  PhotoUploadResult,
  ConnectionTestResult,
  TagSyncResult,
  WebhookEvent,
  ProlineApiResponse,
  ProlineCreateAlertRequest,
  ProlineCreateProjectFileRequest,
  ProlineEditProjectRequest,
  ProlineImportTagsRequest,
  ProlineListProjectsRequest,
  ProlineProjectResponse,
  ProlineWebhookPayload,
} from "../../utils/interfaces/integrations";
import { PROLINE_RECORD_TYPE } from "../../utils/enums/integrations";
import { config } from "../../utils/configuration/config";
import { geocodeStructuredAddress } from "../../services/geocodingService";

export class ProlineProvider extends BaseProvider {
  readonly providerName = "proline";
  readonly displayName = "Proline";
  readonly apiBaseUrl = config.PROLINE_API_URL;

  /**
   * Proline authenticates with two headers rather than a bearer token, so the
   * BaseProvider default is replaced entirely.
   */
  protected getAuthHeaders(): Record<string, string> {
    return {
      PARTNER_KEY: config.PROLINE_PARTNER_KEY || "",
      COMPANY_KEY: this.integration.credentials?.apiKey || "",
      "Content-Type": "application/json",
    };
  }

  /**
   * Validate credentials with a read-only call.
   *
   * /v1/list/projects with limit 1 is the cheapest endpoint that exercises both
   * keys and mutates nothing.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const companyKey = this.integration.credentials?.apiKey;

    if (!companyKey || !companyKey.trim()) {
      return {
        success: false,
        errorMessage:
          "Proline company token is missing. Copy it from the company's Proline integrations page.",
      };
    }

    if (!config.PROLINE_PARTNER_KEY) {
      return {
        success: false,
        errorMessage:
          "PROLINE_PARTNER_KEY is not configured on the server. Set it before connecting Proline.",
      };
    }

    try {
      const body: ProlineListProjectsRequest = { page: 1, limit: 1 };
      await this.callProline<ProlineApiResponse>(
        "/v1/list/projects",
        body as unknown as Record<string, unknown>,
      );

      return {
        success: true,
        accountName: this.integration.name || "Proline Account",
      };
    } catch (error) {
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : "Connection failed",
      };
    }
  }

  /**
   * POST a JSON body to a Partner API endpoint and surface Proline's errors.
   *
   * Proline documents no response envelope, and a breached rate limit comes
   * back as an error stating "condition is not met" — which may arrive with a
   * 200 status. So a 2xx alone isn't success: the body is also inspected for an
   * error field, and anything found is thrown so the caller's sync job retries
   * with the existing exponential backoff.
   */
  private async callProline<T extends ProlineApiResponse>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.makeRequest<T>("POST", endpoint, body);

    const failure =
      typeof response?.error === "string" && response.error
        ? response.error
        : response?.status === "error" && typeof response?.message === "string"
          ? response.message
          : undefined;

    if (failure) {
      throw new Error(`Proline API error on ${endpoint}: ${failure}`);
    }

    return response;
  }

  /**
   * Parse an inbound Proline webhook.
   *
   * Proline sends the whole project record with no envelope, so the only
   * validity test is a usable `project_id`. Returns null for anything else
   * (contact payloads, pings, malformed bodies) so the route drops it quietly.
   */
  parseWebhook(
    headers: Record<string, string>,
    body: unknown,
  ): WebhookEvent | null {
    // Proline authenticates via the URL secret, not headers.
    void headers;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }

    const payload = body as ProlineWebhookPayload;
    const projectId =
      typeof payload.project_id === "string" ? payload.project_id.trim() : "";

    if (!projectId) {
      return null;
    }

    // Proline has no event-type field today; accept one if a future payload
    // carries it, otherwise label every delivery as an upsert.
    const eventType =
      (typeof payload.event === "string" && payload.event) ||
      (typeof payload.event_type === "string" && payload.event_type) ||
      "project.upserted";

    return {
      eventId: projectId,
      eventType,
      payload: payload as unknown as Record<string, unknown>,
    };
  }

  /**
   * Verify webhook authenticity.
   *
   * Proline offers no request signing, so the shared secret in the webhook URL
   * is the only credential — it is checked at the route level before this runs.
   */
  verifyWebhookSignature(
    headers: Record<string, string>,
    body: unknown,
    secret: string,
  ): boolean {
    void headers;
    void body;
    void secret;
    return true;
  }

  /**
   * Normalize a Proline webhook payload into CrewCam project fields.
   *
   * Proline's payload is flat and fully null-padded (it sends every column with
   * `null` for anything unset), and it commonly leaves the structured address
   * fields empty while putting a human-entered string in `location` — so the
   * address is geocoded from whichever of the two is actually populated.
   */
  async normalizeInboundPayload(
    payload: Record<string, unknown>,
  ): Promise<InboundProjectData | null> {
    const data = payload as ProlineWebhookPayload;
    const externalId =
      typeof data.project_id === "string" ? data.project_id.trim() : "";

    if (!externalId) {
      return null;
    }

    const contactName = joinNonEmpty(
      [data.contact_fname, data.contact_lname],
      " ",
    );

    const name =
      text(data.project_name) ||
      text(data.contact_display) ||
      contactName ||
      text(data.project_number) ||
      "Untitled Project";

    const geocoded = await this.resolveAddress(data);

    return {
      externalId,
      externalUrl: this.getProjectUrl(externalId),
      name,
      address: geocoded?.formattedAddress,
      customerName: text(data.contact_display) || contactName || undefined,
      customerEmail: text(data.contact_email) || undefined,
      customerPhone: text(data.contact_phone) || undefined,
      description: text(data.notes) || undefined,
      tags: collectTags(data),
      coordinates:
        geocoded?.latitude !== undefined
          ? { latitude: geocoded.latitude, longitude: geocoded.longitude }
          : undefined,
      projectType: PROLINE_RECORD_TYPE.project,
      rawData: payload,
    };
  }

  /**
   * Geocode the project address, preferring structured fields and falling back
   * to the free-text `location`. A geocoding failure must not fail the sync, so
   * errors degrade to "no address" rather than propagating.
   */
  private async resolveAddress(data: ProlineWebhookPayload) {
    const components = {
      line1: text(data.address1),
      line2: text(data.address2),
      city: text(data.city),
      state: text(data.state),
      zip: text(data.zip),
    };

    const hasStructured = Object.values(components).some(Boolean);
    const fallback = text(data.location);

    if (!hasStructured && !fallback) {
      return null;
    }

    try {
      return await geocodeStructuredAddress(
        hasStructured ? components : { line1: fallback },
      );
    } catch (error) {
      console.error(
        `Proline: failed to geocode address for project ${data.project_id}:`,
        error,
      );
      // Keep the raw string so the project still shows a location.
      return {
        formattedAddress: hasStructured
          ? Object.values(components).filter(Boolean).join(", ")
          : fallback,
      };
    }
  }

  /**
   * Fetch a project from Proline via POST /v1/find/project.
   *
   * The inbound webhook path doesn't need this (it works off the payload), but
   * it backs manual re-sync and diagnostics.
   */
  async getProject(externalId: string): Promise<ExternalProject | null> {
    try {
      const response = await this.callProline<
        ProlineApiResponse & { response?: ProlineProjectResponse }
      >("/v1/find/project", { project_id: externalId });

      // Proline may return the record at the top level or nested under
      // `response`; neither shape is documented, so accept both.
      const project = (response.response ||
        response) as unknown as ProlineProjectResponse;

      const projectId = text(project.project_id) || externalId;
      const contactName = joinNonEmpty(
        [project.contact_fname, project.contact_lname],
        " ",
      );

      return {
        externalId: projectId,
        externalUrl: this.getProjectUrl(projectId),
        name:
          text(project.project_name) ||
          text(project.contact_display) ||
          "Untitled Project",
        address:
          joinNonEmpty(
            [
              project.address1,
              project.address2,
              project.city,
              project.state,
              project.zip,
            ],
            ", ",
          ) || text(project.location),
        customerName: text(project.contact_display) || contactName || undefined,
        customerEmail: text(project.contact_email) || undefined,
        customerPhone: text(project.contact_phone) || undefined,
        rawData: project as unknown as Record<string, unknown>,
      };
    } catch (error) {
      console.error(`Proline: failed to fetch project ${externalId}:`, error);
      return null;
    }
  }

  /**
   * Attach a photo to a Proline project via POST /v1/files/create_project_file.
   *
   * Proline pulls the file itself from `file_url`, so nothing is uploaded here —
   * the S3/CDN URL is handed over as-is and must stay publicly reachable until
   * Proline fetches it. The endpoint takes no description or tag field, so the
   * post's note and tags travel separately via createActivity.
   */
  async uploadPhoto(
    externalProjectId: string,
    photo: PhotoUploadPayload,
  ): Promise<PhotoUploadResult> {
    try {
      const body: ProlineCreateProjectFileRequest = {
        project_id: externalProjectId,
        file_url: photo.fileUrl,
        file_name: photo.fileName,
      };

      const response = await this.callProline<ProlineApiResponse>(
        "/v1/files/create_project_file",
        body as unknown as Record<string, unknown>,
      );

      return {
        success: true,
        externalAttachmentId:
          text(response.file_id) || text(response.id) || undefined,
        rawResponse: response as Record<string, unknown>,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : "Upload failed",
      };
    }
  }

  /**
   * Mirror a CrewCam post onto the Proline project timeline via
   * POST /v1/activity/create_alert.
   *
   * create_alert is the only documented project-scoped free-text activity;
   * create_message and import/activity are comms-log shaped and require
   * Proline contact/user IDs we don't hold.
   */
  async createActivity(
    externalProjectId: string,
    activity: ActivityPushPayload,
  ): Promise<ActivityPushResult> {
    try {
      const body: ProlineCreateAlertRequest = {
        project_id: externalProjectId,
        alert_text: buildAlertText(activity),
        alert_extended: buildAlertHtml(activity),
      };

      const response = await this.callProline<ProlineApiResponse>(
        "/v1/activity/create_alert",
        body as unknown as Record<string, unknown>,
      );

      return {
        success: true,
        externalActivityId:
          text(response.activity_id) || text(response.id) || undefined,
        rawResponse: response as Record<string, unknown>,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : "Activity push failed",
      };
    }
  }

  /**
   * Register tag names in the company's Proline vocabulary via
   * POST /v1/import/tags.
   *
   * This creates the tag definitions only. Attaching them to a project needs
   * Proline's own tag IDs (see attachProjectTags), and the Partner API exposes
   * no way to look an ID up from a name — so a CrewCam tag can be created here
   * but not bound to the project until Proline provides that mapping.
   */
  async syncTagDefinitions(tagNames: string[]): Promise<TagSyncResult> {
    const tags = Array.from(
      new Set(tagNames.map(text).filter((t): t is string => Boolean(t))),
    );

    if (tags.length === 0) {
      return { success: true, syncedTags: [] };
    }

    try {
      const body: ProlineImportTagsRequest = { project_tags: tags };

      const response = await this.callProline<ProlineApiResponse>(
        "/v1/import/tags",
        body as unknown as Record<string, unknown>,
      );

      return {
        success: true,
        syncedTags: tags,
        rawResponse: response as Record<string, unknown>,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : "Tag sync failed",
      };
    }
  }

  /**
   * Attach existing Proline tags to a project via POST /v1/edit/project.
   *
   * `project_tags` takes Proline tag unique IDs, never names — passing names
   * here is silently wrong, so callers must already hold real IDs.
   */
  async attachProjectTags(
    externalProjectId: string,
    prolineTagIds: string[],
  ): Promise<TagSyncResult> {
    const tagIds = prolineTagIds
      .map(text)
      .filter((t): t is string => Boolean(t));

    if (tagIds.length === 0) {
      return { success: true, syncedTags: [] };
    }

    try {
      const body: ProlineEditProjectRequest = {
        project_id: externalProjectId,
        project_tags: tagIds,
      };

      const response = await this.callProline<ProlineApiResponse>(
        "/v1/edit/project",
        body as unknown as Record<string, unknown>,
      );

      return {
        success: true,
        syncedTags: tagIds,
        rawResponse: response as Record<string, unknown>,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : "Tag attach failed",
      };
    }
  }

  /**
   * Deep link to the project inside Proline.
   */
  getProjectUrl(externalId: string): string {
    return `${config.PROLINE_APP_URL}/boards/projects/${externalId}`;
  }
}

/** Trim a possibly-null Proline string field down to a usable value. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function joinNonEmpty(values: unknown[], separator: string): string {
  return values.map(text).filter(Boolean).join(separator);
}

/** Escape a string for safe interpolation into alert_extended's HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain-text body for a post mirrored onto the Proline timeline. */
function buildAlertText(activity: ActivityPushPayload): string {
  const lines = [
    activity.text,
    "",
    `Posted by ${activity.authorName} in RelayCam`,
  ];

  if (activity.fileCount) {
    lines.push(
      `${activity.fileCount} photo${activity.fileCount === 1 ? "" : "s"} attached`,
    );
  }
  if (activity.tags?.length) {
    lines.push(`Tags: ${activity.tags.join(", ")}`);
  }
  if (activity.postUrl) {
    lines.push(`View post: ${activity.postUrl}`);
  }

  return lines.join("\n");
}

/** HTML body for the same post; Proline renders alert_extended when present. */
function buildAlertHtml(activity: ActivityPushPayload): string {
  const parts = [
    `<p>${escapeHtml(activity.text).replace(/\n/g, "<br />")}</p>`,
  ];

  const meta = [
    `Posted by <strong>${escapeHtml(activity.authorName)}</strong> in RelayCam`,
  ];
  if (activity.fileCount) {
    meta.push(
      `${activity.fileCount} photo${activity.fileCount === 1 ? "" : "s"} attached`,
    );
  }
  if (activity.tags?.length) {
    meta.push(`Tags: ${escapeHtml(activity.tags.join(", "))}`);
  }
  parts.push(`<p>${meta.join(" &middot; ")}</p>`);

  if (activity.postUrl) {
    const url = escapeHtml(activity.postUrl);
    parts.push(`<p><a href="${url}">View post in RelayCam</a></p>`);
  }

  return parts.join("");
}

/**
 * Merge Proline's two tag arrays into one deduped list.
 * Proline populates `tags` and `project_tags` inconsistently across payloads.
 */
function collectTags(data: ProlineWebhookPayload): string[] | undefined {
  const raw = [
    ...(Array.isArray(data.tags) ? data.tags : []),
    ...(Array.isArray(data.project_tags) ? data.project_tags : []),
  ];

  const unique = Array.from(
    new Set(raw.map(text).filter((tag): tag is string => Boolean(tag))),
  );

  return unique.length > 0 ? unique : undefined;
}
