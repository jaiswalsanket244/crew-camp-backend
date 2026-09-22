/**
 * JobNimbus CRM integration provider.
 *
 * API Documentation: https://documenter.getpostman.com/view/3919598/S11PpG4x
 * Base URL: https://app.jobnimbus.com/api1
 * Auth: Bearer token (API key)
 */

import { BaseProvider } from "./base";
import {
  ExternalProject,
  PhotoUploadPayload,
  PhotoUploadResult,
  ConnectionTestResult,
  WebhookEvent,
  CreateProjectPayload,
  CreateProjectResult,
  UpdateProjectPayload,
  UpdateProjectResult,
} from "../../utils/interfaces/integrations";

// JobNimbus API response types
interface JobNimbusJob {
  jnid: string;
  display_name?: string;
  name?: string;
  description?: string;
  primary?: {
    name?: string; // Combined name (from webhook)
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state_text?: string;
  zip?: string;
  country?: string;
  status_name?: string;
  created?: number;
  [key: string]: unknown;
}

interface JobNimbusContact {
  jnid: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  email?: string;
  [key: string]: unknown;
}

interface JobNimbusListResponse<T> {
  count: number;
  results: T[];
}

interface JobNimbusFileResponse {
  jnid: string;
  filename?: string;
  [key: string]: unknown;
}

export class JobNimbusProvider extends BaseProvider {
  readonly providerName = "jobnimbus";
  readonly displayName = "JobNimbus";
  readonly apiBaseUrl = "https://app.jobnimbus.com/api1";

  /**
   * Test connection by fetching contacts list.
   * If API key is valid, this succeeds.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      // Fetch contacts as a simple test - if API key is valid, this works
      await this.makeRequest<JobNimbusListResponse<JobNimbusContact>>(
        "GET",
        "/contacts?limit=1",
      );

      return {
        success: true,
        accountName: "JobNimbus Account",
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
   * Parse incoming webhook from JobNimbus.
   * Returns null if event type should be ignored.
   */
  parseWebhook(
    headers: Record<string, string>,
    body: unknown,
  ): WebhookEvent | null {
    // Headers can be used for additional context (e.g., user-agent, timestamp)
    void headers;

    // Handle null/undefined body
    if (!body || typeof body !== "object") {
      return null;
    }

    const payload = body as Record<string, unknown>;

    // Extract event type and ID
    // JobNimbus webhook format may vary - adjust based on actual format
    const eventType =
      (payload.event as string) ||
      (payload.type as string) ||
      (payload.action as string);
    const eventId =
      (payload.id as string) || (payload.jnid as string) || `jn_${Date.now()}`;

    // Only process job creation events for inbound sync
    // Adjust these conditions based on actual JobNimbus webhook format
    if (!eventType) {
      // If no event type, check if this is a job object directly
      if (payload.jnid && payload.record_type_name === "Job") {
        return {
          eventId: payload.jnid as string,
          eventType: "job.created",
          payload,
        };
      }
      return null;
    }

    // Filter for job-related events
    const isJobEvent =
      eventType.toLowerCase().includes("job") ||
      (payload.record_type_name as string)?.toLowerCase() === "job" ||
      (payload.type as string)?.toLowerCase() === "contact";

    if (!isJobEvent) {
      return null;
    }

    return {
      eventId,
      eventType,
      payload,
    };
  }

  /**
   * Verify webhook signature.
   * JobNimbus uses URL secret for verification (checked at route level).
   * This method exists for providers that use header-based signatures.
   */
  verifyWebhookSignature(
    headers: Record<string, string>,
    body: unknown,
    secret: string,
  ): boolean {
    // Mark parameters as intentionally unused
    void headers;
    void body;
    void secret;
    // JobNimbus uses a secret in the webhook URL for verification
    // The actual verification happens at the route level by checking query param
    return true;
  }

  /**
   * Fetch job details from JobNimbus.
   */
  async getProject(externalId: string): Promise<ExternalProject | null> {
    try {
      const job = await this.makeRequest<JobNimbusJob>(
        "GET",
        `/jobs/${externalId}`,
      );

      // Build address string from components
      const addressParts = [
        job.address_line1,
        job.address_line2,
        job.city,
        job.state_text,
        job.zip,
      ].filter(Boolean);

      // Build customer name (handle both combined 'name' and separate first/last)
      let customerName: string | undefined;
      if (job.primary) {
        if (job.primary.name) {
          // Webhook sends combined name
          customerName = job.primary.name;
        } else {
          // API might send separate first/last
          const nameParts = [
            job.primary.first_name,
            job.primary.last_name,
          ].filter(Boolean);
          customerName = nameParts.length > 0 ? nameParts.join(" ") : undefined;
        }
      }

      return {
        externalId: job.jnid,
        externalUrl: this.getProjectUrl(job.jnid),
        name: job.display_name || job.name || "Untitled Job",
        address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
        customerName,
        customerEmail: job.primary?.email,
        customerPhone: job.primary?.phone,
        rawData: job,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Create a new job in JobNimbus.
   */
  async createProject(
    project: CreateProjectPayload,
  ): Promise<CreateProjectResult> {
    try {
      // Build the JobNimbus job creation payload
      const jobPayload: Record<string, unknown> = {
        name: project.name,
        record_type_name: "Residential",
        status_name: "Lead",
        external_id: project._id, // Store CrewCam project ID for reference
      };

      // Add description if provided
      if (project.description) {
        jobPayload.description = project.description;
      }

      // Add geo coordinates if provided
      if (project.geo && project.geo.lat && project.geo.lon) {
        jobPayload.geo = {
          lat: project.geo.lat,
          lon: project.geo.lon,
        };
      }

      // Add address fields if provided
      if (project.address) {
        if (project.address.line1) {
          jobPayload.address_line1 = project.address.line1;
        }
        if (project.address.line2) {
          jobPayload.address_line2 = project.address.line2;
        }
        if (project.address.city) {
          jobPayload.city = project.address.city;
        }
        if (project.address.state) {
          jobPayload.state_text = project.address.state;
        }
        if (project.address.zip) {
          jobPayload.zip = project.address.zip;
        }
      }

      // Add primary contact if provided
      if (project.customer) {
        const primary: Record<string, unknown> = {};

        // If we have an existing contact ID, use it
        if (project.customer.contactId) {
          primary.id = project.customer.contactId;
        } else {
          // Otherwise, include contact details
          if (project.customer.firstName || project.customer.lastName) {
            primary.first_name = project.customer.firstName;
            primary.last_name = project.customer.lastName;
          }
          if (project.customer.email) {
            primary.email = project.customer.email;
          }
          if (project.customer.phone) {
            primary.phone = project.customer.phone;
          }
        }

        if (Object.keys(primary).length > 0) {
          jobPayload.primary = primary;
        }
      }

      // Add tags if provided (JobNimbus expects comma-separated string)
      if (project.tags && project.tags.length > 0) {
        jobPayload.tags = project.tags.join(",");
      }

      // Add any custom fields
      if (project.customFields) {
        Object.assign(jobPayload, project.customFields);
      }

      // Create the job
      const response = await this.makeRequest<JobNimbusJob>(
        "POST",
        "/jobs",
        jobPayload,
      );

      if (response?.jnid) {
        return {
          success: true,
          externalId: response.jnid,
          externalUrl: this.getProjectUrl(response.jnid),
          rawResponse: response,
        };
      } else {
        return {
          success: false,
          errorMessage: "No job ID returned from JobNimbus",
        };
      }
    } catch (error) {
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : "Creation failed",
      };
    }
  }

  /**
   * Update an existing job in JobNimbus.
   */
  async updateProject(
    project: UpdateProjectPayload,
  ): Promise<UpdateProjectResult> {
    try {
      // Build the JobNimbus job update payload
      const jobPayload: Record<string, unknown> = {};

      // Only include fields that are provided
      if (project.name !== undefined) {
        jobPayload.name = project.name;
      }

      if (project.description !== undefined) {
        jobPayload.description = project.description;
      }

      // Add geo coordinates if provided
      if (project.geo) {
        if (project.geo.lat !== undefined && project.geo.lon !== undefined) {
          jobPayload.geo = {
            lat: project.geo.lat,
            lon: project.geo.lon,
          };
        }
      }

      // Add address fields if provided
      if (project.address) {
        if (project.address.line1 !== undefined) {
          jobPayload.address_line1 = project.address.line1;
        }
        if (project.address.line2 !== undefined) {
          jobPayload.address_line2 = project.address.line2;
        }
        if (project.address.city !== undefined) {
          jobPayload.city = project.address.city;
        }
        if (project.address.state !== undefined) {
          jobPayload.state_text = project.address.state;
        }
        if (project.address.zip !== undefined) {
          jobPayload.zip = project.address.zip;
        }
      }

      // // Add status if provided
      // if (project.status !== undefined) {
      //   jobPayload.status_name = project.status;
      // }

      // Add primary contact if provided
      if (project.customer) {
        const primary: Record<string, unknown> = {};

        // If we have an existing contact ID, use it
        if (project.customer.contactId) {
          primary.id = project.customer.contactId;
        } else {
          // Otherwise, include contact details
          if (project.customer.firstName !== undefined) {
            primary.first_name = project.customer.firstName;
          }
          if (project.customer.lastName !== undefined) {
            primary.last_name = project.customer.lastName;
          }
          if (project.customer.email !== undefined) {
            primary.email = project.customer.email;
          }
          if (project.customer.phone !== undefined) {
            primary.phone = project.customer.phone;
          }
        }

        if (Object.keys(primary).length > 0) {
          jobPayload.primary = primary;
        }
      }

      // Add tags if provided (JobNimbus expects comma-separated string)
      if (project.tags && project.tags.length > 0) {
        jobPayload.tags = project.tags.join(",");
      }

      // Add any custom fields
      if (project.customFields) {
        Object.assign(jobPayload, project.customFields);
      }

      // Update the job using PUT request
      const response = await this.makeRequest<JobNimbusJob>(
        "PUT",
        `/jobs/${project.externalId}`,
        jobPayload,
      );

      if (response?.jnid) {
        return {
          success: true,
          externalId: response.jnid,
          externalUrl: this.getProjectUrl(response.jnid),
          rawResponse: response,
        };
      } else {
        return {
          success: false,
          errorMessage: "No job ID returned from JobNimbus",
        };
      }
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : "Update failed",
      };
    }
  }

  /**
   * Upload photo to JobNimbus job as an attachment.
   * JobNimbus requires base64-encoded file data in JSON format.
   */
  async uploadPhoto(
    externalProjectId: string,
    photo: PhotoUploadPayload,
  ): Promise<PhotoUploadResult> {
    try {
      // Download the photo from S3 and convert to base64
      const photoBuffer = await this.downloadFile(photo.fileUrl);
      const base64Data = photoBuffer.toString("base64");

      // Build description with metadata
      const description = this.buildPhotoDescription(photo);

      // JobNimbus file upload payload format
      // See: https://documenter.getpostman.com/view/3919598/S11PpG4x
      const payload = {
        data: base64Data, // Base64-encoded file data
        related: [externalProjectId], // Array of related record jnids
        type: 1, // File type: 1 for general files
        subtype: "job", // Subtype: "job" for job attachments
        filename: photo.fileName,
        description: description,
        // is_private: false, // Public file
        persist: true, // Persist the file
        date: Math.floor(photo.uploadedAt.getTime() / 1000), // Unix timestamp
      };

      // Upload to JobNimbus files endpoint using JSON
      const response = await this.makeRequest<JobNimbusFileResponse>(
        "POST",
        "/files",
        payload,
      );

      return {
        success: true,
        externalAttachmentId: response.jnid,
        rawResponse: response,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : "Upload failed",
      };
    }
  }

  /**
   * Generate JobNimbus job URL.
   */
  getProjectUrl(externalId: string): string {
    return `https://app.jobnimbus.com/job/${externalId}`;
  }

  /**
   * Build description text for uploaded photos.
   */
  private buildPhotoDescription(photo: PhotoUploadPayload): string {
    const lines = [
      "Uploaded from RelayCam",
      `By: ${photo.uploadedBy}`,
      `Project: ${photo.projectName}`,
      `Date: ${photo.uploadedAt.toISOString()}`,
    ];

    if (photo.tags && photo.tags.length > 0) {
      lines.push(`Tags: ${photo.tags.join(", ")}`);
    }

    photo.postUrl && lines.push(`View Post in RelayCam: ${photo.postUrl}`);
    photo.projectUrl &&
      lines.push(`View Project in RelayCam: ${photo.projectUrl}`);

    return lines.join("\n");
  }
}
