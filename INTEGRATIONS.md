# CrewCam Integrations - Technical Approach

This document outlines the architecture and implementation plan for CRM integrations, starting with JobNimbus. Designed for extensibility so future CRMs (Roofr, AccuLynx) plug in with minimal code.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Directory Structure](#directory-structure)
3. [Data Models](#data-models)
4. [Provider Interface](#provider-interface)
5. [JobNimbus Implementation](#jobnimbus-implementation)
6. [API Endpoints](#api-endpoints)
7. [Sync Flows](#sync-flows)
8. [Error Handling & Retries](#error-handling--retries)
9. [Adding a New CRM Provider](#adding-a-new-crm-provider)
10. [Implementation Checklist](#implementation-checklist)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CrewCam Backend                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Integration │    │   Provider   │    │    Sync      │      │
│  │    Routes    │───▶│   Manager    │───▶│   Service    │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                   │               │
│         │            ┌──────┴──────┐            │               │
│         │            ▼             ▼            │               │
│         │     ┌──────────┐  ┌──────────┐        │               │
│         │     │JobNimbus │  │  Roofr   │        │               │
│         │     │ Provider │  │ Provider │        │               │
│         │     └──────────┘  └──────────┘        │               │
│         │            │             │            │               │
│         ▼            ▼             ▼            ▼               │
│  ┌─────────────────────────────────────────────────────┐       │
│  │                    MongoDB                           │       │
│  │  ┌────────────┐ ┌────────┐ ┌────────┐ ┌──────────┐  │       │
│  │  │Integration │ │Project │ │SyncJob │ │Processed │  │       │
│  │  │            │ │        │ │        │ │ Webhook  │  │       │
│  │  └────────────┘ └────────┘ └────────┘ └──────────┘  │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌──────────┐    ┌──────────┐    ┌──────────┐
       │JobNimbus │    │  Roofr   │    │AccuLynx  │
       │   API    │    │   API    │    │   API    │
       └──────────┘    └──────────┘    └──────────┘
```

### Key Principles

1. **Provider Pattern**: Each CRM implements a standard interface. Business logic is shared; only API specifics differ.
2. **Workspace-Scoped**: Integrations are enabled per workspace (company), not globally.
3. **External ID is Source of Truth**: Projects are linked via `externalId`, never by name matching.
4. **Async Processing**: All external API calls happen asynchronously with retry logic.
5. **Fail-Safe**: Integration failures never block core CrewCam operations.

---

## Directory Structure

```
lib/
├── integrations/
│   ├── index.ts                    # Exports all integration modules
│   ├── manager.ts                  # Routes requests to correct provider
│   ├── syncService.ts              # Handles sync job processing & retries
│   ├── types.ts                    # Shared TypeScript interfaces
│   └── providers/
│       ├── base.ts                 # Abstract base class (interface)
│       ├── jobnimbus.ts            # JobNimbus implementation
│       └── roofr.ts                # Future: Roofr implementation
│
├── db/
│   ├── integration.ts              # Integration schema (NEW)
│   ├── syncJob.ts                  # Sync job schema (NEW)
│   ├── processedWebhook.ts         # Webhook idempotency (NEW)
│   └── projects.ts                 # Extended with externalMapping
│
├── routes/
│   ├── integrations/
│   │   ├── index.ts                # Router setup
│   │   └── routes.ts               # Route handlers
│   └── webhooks/
│       ├── index.ts                # Add jobnimbus route
│       └── routes.ts               # Add jobnimbus handler
│
└── services/
    └── integrationHooks.ts         # Hooks into post upload flow
```

---

## Data Models

### 1. Integration (NEW: `lib/db/integration.ts`)

Stores connection configuration per workspace.

```typescript
import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const INTEGRATION_PROVIDERS = ["jobnimbus", "roofr", "acculynx"] as const;
export type IntegrationProvider = typeof INTEGRATION_PROVIDERS[number];

export const INTEGRATION_STATUS = ["connected", "disconnected", "error"] as const;
export type IntegrationStatus = typeof INTEGRATION_STATUS[number];

export interface IIntegration {
  _id: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;       // Workspace
  provider: IntegrationProvider;

  // Authentication
  credentials: {
    apiKey: string;                          // Stored encrypted
    // Future: accessToken, refreshToken, expiresAt for OAuth
  };

  // Feature toggles
  settings: {
    inboundSyncEnabled: boolean;             // Create projects from CRM
    outboundSyncEnabled: boolean;            // Send photos to CRM
  };

  // Webhook configuration
  webhookSecret: string;                     // For signature verification

  // Health tracking
  status: IntegrationStatus;
  lastSuccessfulSync: Date | null;
  lastError: {
    message: string;
    occurredAt: Date;
    code: string;
  } | null;

  createdAt: Date;
  updatedAt: Date;
}

export const IntegrationSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: true,
    },
    provider: {
      type: String,
      enum: INTEGRATION_PROVIDERS,
      required: true,
    },
    credentials: {
      apiKey: { type: String, required: true },
    },
    settings: {
      inboundSyncEnabled: { type: Boolean, default: true },
      outboundSyncEnabled: { type: Boolean, default: true },
    },
    webhookSecret: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: INTEGRATION_STATUS,
      default: "disconnected",
    },
    lastSuccessfulSync: { type: Date, default: null },
    lastError: {
      message: { type: String },
      occurredAt: { type: Date },
      code: { type: String },
    },
  },
  { timestamps: true }
);

// One integration per provider per workspace
IntegrationSchema.index({ companyId: 1, provider: 1 }, { unique: true });
```

### 2. SyncJob (NEW: `lib/db/syncJob.ts`)

Tracks individual sync operations for retry and debugging.

```typescript
import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const SYNC_JOB_TYPE = ["inbound_project", "outbound_photo"] as const;
export const SYNC_JOB_STATUS = ["pending", "processing", "completed", "failed"] as const;

export interface ISyncJob {
  _id: mongoose.Types.ObjectId;
  integrationId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;

  type: typeof SYNC_JOB_TYPE[number];
  status: typeof SYNC_JOB_STATUS[number];

  // Job payload (photo data, project data, etc.)
  payload: Record<string, any>;

  // Retry tracking
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;

  // Result
  result: {
    success: boolean;
    externalId?: string;
    errorMessage?: string;
    rawResponse?: Record<string, any>;
  } | null;

  createdAt: Date;
  updatedAt: Date;
}

export const SyncJobSchema = new mongoose.Schema(
  {
    integrationId: {
      type: ObjectId,
      ref: "Integration",
      required: true,
    },
    projectId: {
      type: ObjectId,
      ref: "project",
      required: false,
    },
    type: {
      type: String,
      enum: SYNC_JOB_TYPE,
      required: true,
    },
    status: {
      type: String,
      enum: SYNC_JOB_STATUS,
      default: "pending",
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lastAttemptAt: { type: Date, default: null },
    nextRetryAt: { type: Date, default: null },
    result: {
      success: { type: Boolean },
      externalId: { type: String },
      errorMessage: { type: String },
      rawResponse: { type: mongoose.Schema.Types.Mixed },
    },
  },
  { timestamps: true }
);

// Index for finding jobs to process
SyncJobSchema.index({ status: 1, nextRetryAt: 1 });
SyncJobSchema.index({ integrationId: 1, status: 1 });
```

### 3. ProcessedWebhook (NEW: `lib/db/processedWebhook.ts`)

Prevents duplicate webhook processing (idempotency).

```typescript
import * as mongoose from "mongoose";

export const ProcessedWebhookSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
    },
    provider: {
      type: String,
      required: true,
    },
    processedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

// Compound unique index
ProcessedWebhookSchema.index({ eventId: 1, provider: 1 }, { unique: true });

// Auto-delete after 7 days
ProcessedWebhookSchema.index({ processedAt: 1 }, { expireAfterSeconds: 604800 });
```

### 4. Project Model Extension

Add external mapping to existing `lib/db/projects.ts`:

```typescript
// Add to ProjectSchema definition:
externalMapping: {
  system: {
    type: String,
    enum: ["jobnimbus", "roofr", "acculynx"],
    required: false,
  },
  externalId: {
    type: String,
    required: false,
  },
  externalUrl: {
    type: String,
    required: false,
  },
  lastOutboundSync: {
    type: Date,
    required: false,
  },
  lastSyncError: {
    type: String,
    required: false,
  },
},

// Add compound unique index (after schema definition):
ProjectSchema.index(
  { companyId: 1, "externalMapping.system": 1, "externalMapping.externalId": 1 },
  { unique: true, sparse: true }
);
```

---

## Provider Interface

### Base Provider (`lib/integrations/providers/base.ts`)

All CRM providers implement this interface.

```typescript
import { IIntegration } from "../../db/integration";

// Standardized types for all providers
export interface ExternalProject {
  externalId: string;
  externalUrl: string;
  name: string;
  address?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  rawData: Record<string, any>;      // Original response for debugging
}

export interface PhotoUploadPayload {
  fileUrl: string;                    // S3 URL of photo
  fileName: string;
  mimeType: string;
  uploadedBy: string;                 // User full name
  uploadedAt: Date;
  projectName: string;
  projectUrl: string;                 // CrewCam project URL
  tags?: string[];
}

export interface PhotoUploadResult {
  success: boolean;
  externalAttachmentId?: string;
  errorMessage?: string;
  rawResponse?: Record<string, any>;
}

export interface ConnectionTestResult {
  success: boolean;
  accountName?: string;               // For display: "Connected as: Company Name"
  errorMessage?: string;
}

export interface WebhookEvent {
  eventId: string;                    // For idempotency
  eventType: string;                  // "job.created", "job.updated", etc.
  payload: Record<string, any>;
}

/**
 * Abstract base class for CRM providers.
 *
 * To add a new CRM:
 * 1. Create new file in providers/ (e.g., roofr.ts)
 * 2. Extend BaseProvider
 * 3. Implement all abstract methods
 * 4. Register in manager.ts
 */
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
  abstract parseWebhook(headers: Record<string, string>, body: any): WebhookEvent | null;

  /**
   * Verify webhook signature.
   * Return false to reject the webhook.
   */
  abstract verifyWebhookSignature(headers: Record<string, string>, body: any): boolean;

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
    photo: PhotoUploadPayload
  ): Promise<PhotoUploadResult>;

  /**
   * Generate the external URL for a project/job.
   */
  abstract getProjectUrl(externalId: string): string;

  // ─────────────────────────────────────────────────────────
  // Shared utilities (inherited by all providers)
  // ─────────────────────────────────────────────────────────

  protected getAuthHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.integration.credentials.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  protected async makeRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    data?: any
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${endpoint}`;
    const response = await fetch(url, {
      method,
      headers: this.getAuthHeaders(),
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`${this.providerName} API error: ${response.status} - ${error}`);
    }

    return response.json();
  }
}
```

---

## JobNimbus Implementation

### Provider (`lib/integrations/providers/jobnimbus.ts`)

```typescript
import {
  BaseProvider,
  ExternalProject,
  PhotoUploadPayload,
  PhotoUploadResult,
  ConnectionTestResult,
  WebhookEvent
} from "./base";

interface JobNimbusJob {
  jnid: string;
  display_name: string;
  primary?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
  address_line1?: string;
  city?: string;
  state_text?: string;
  zip?: string;
  // ... other fields
}

interface JobNimbusContact {
  jnid: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  email?: string;
  // ... other fields
}

export class JobNimbusProvider extends BaseProvider {
  readonly providerName = "jobnimbus";
  readonly displayName = "JobNimbus";
  readonly apiBaseUrl = "https://app.jobnimbus.com/api1";

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      // Fetch contacts as a simple test - if API key is valid, this works
      const response = await this.makeRequest<{ results: JobNimbusContact[] }>(
        "GET",
        "/contacts?limit=1"
      );

      return {
        success: true,
        accountName: "JobNimbus Account", // API doesn't return account name
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }

  parseWebhook(headers: Record<string, string>, body: any): WebhookEvent | null {
    // JobNimbus webhook structure
    // Note: Verify actual webhook format when testing
    const eventType = body.event || body.type;
    const eventId = body.id || body.jnid || `${Date.now()}`;

    // Only process job creation events
    if (!eventType?.includes("job") || !eventType?.includes("created")) {
      return null;
    }

    return {
      eventId,
      eventType,
      payload: body,
    };
  }

  verifyWebhookSignature(headers: Record<string, string>, body: any): boolean {
    // JobNimbus webhook signature verification
    // Implement based on their documentation
    // For now, use webhook secret in URL as fallback
    return true;
  }

  async getProject(externalId: string): Promise<ExternalProject | null> {
    try {
      const job = await this.makeRequest<JobNimbusJob>("GET", `/jobs/${externalId}`);

      // Build address string
      const addressParts = [
        job.address_line1,
        job.city,
        job.state_text,
        job.zip,
      ].filter(Boolean);

      return {
        externalId: job.jnid,
        externalUrl: this.getProjectUrl(job.jnid),
        name: job.display_name || "Untitled Job",
        address: addressParts.join(", ") || undefined,
        customerName: job.primary
          ? `${job.primary.first_name || ""} ${job.primary.last_name || ""}`.trim()
          : undefined,
        customerEmail: job.primary?.email,
        customerPhone: job.primary?.phone,
        rawData: job,
      };
    } catch (error) {
      console.error(`Failed to fetch JobNimbus job ${externalId}:`, error);
      return null;
    }
  }

  async uploadPhoto(
    externalProjectId: string,
    photo: PhotoUploadPayload
  ): Promise<PhotoUploadResult> {
    try {
      // JobNimbus file upload approach:
      // 1. Download photo from S3
      // 2. Upload to JobNimbus as attachment

      // Fetch the photo file
      const photoResponse = await fetch(photo.fileUrl);
      if (!photoResponse.ok) {
        throw new Error(`Failed to fetch photo from ${photo.fileUrl}`);
      }
      const photoBuffer = await photoResponse.arrayBuffer();

      // Create form data for multipart upload
      const formData = new FormData();
      formData.append("file", new Blob([photoBuffer]), photo.fileName);
      formData.append("parent_jnid", externalProjectId);
      formData.append("description", this.buildPhotoDescription(photo));

      // Upload to JobNimbus
      const response = await fetch(`${this.apiBaseUrl}/files`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.integration.credentials.apiKey}`,
          // Note: Don't set Content-Type for FormData - browser sets it with boundary
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Upload failed: ${response.status} - ${error}`);
      }

      const result = await response.json();

      return {
        success: true,
        externalAttachmentId: result.jnid || result.id,
        rawResponse: result,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : "Upload failed",
      };
    }
  }

  getProjectUrl(externalId: string): string {
    return `https://app.jobnimbus.com/job/${externalId}`;
  }

  private buildPhotoDescription(photo: PhotoUploadPayload): string {
    const lines = [
      `Uploaded from CrewCam`,
      `By: ${photo.uploadedBy}`,
      `Project: ${photo.projectName}`,
      `Date: ${photo.uploadedAt.toISOString()}`,
    ];

    if (photo.tags?.length) {
      lines.push(`Tags: ${photo.tags.join(", ")}`);
    }

    lines.push(`View in CrewCam: ${photo.projectUrl}`);

    return lines.join("\n");
  }
}
```

---

## API Endpoints

### Routes (`lib/routes/integrations/routes.ts`)

```typescript
import { Request, Response, NextFunction } from "express";
import * as status from "http-status";
import { ErrorResponse, SuccessResponse } from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { IntegrationManager } from "../../integrations/manager";
import { Integration, SyncJob } from "../../db";
import * as crypto from "crypto";

export class IntegrationRoutes {

  /**
   * GET /integrations/status
   * Get integration status for current workspace
   */
  public static async getStatus(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const companyId = req.user.companies?.[0]?.companyId;
      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      const integrations = await Integration.find({ companyId });

      const result = integrations.map(int => ({
        provider: int.provider,
        status: int.status,
        settings: int.settings,
        lastSuccessfulSync: int.lastSuccessfulSync,
        lastError: int.lastError,
      }));

      return SuccessResponse(res, status.OK, {
        message: "Integration status retrieved",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /integrations/connect
   * Connect a CRM integration
   * Body: { provider: "jobnimbus", apiKey: "..." }
   */
  public static async connect(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const companyId = req.user.companies?.[0]?.companyId;
      const { provider, apiKey } = req.body;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      if (!provider || !apiKey) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Provider and API key required",
        });
      }

      // Check if already connected
      const existing = await Integration.findOne({ companyId, provider });
      if (existing?.status === "connected") {
        return ErrorResponse(res, status.CONFLICT, {
          message: `${provider} is already connected`,
        });
      }

      // Create or update integration
      const integration = await Integration.findOneAndUpdate(
        { companyId, provider },
        {
          credentials: { apiKey },
          webhookSecret: crypto.randomBytes(32).toString("hex"),
          status: "disconnected",
          settings: {
            inboundSyncEnabled: true,
            outboundSyncEnabled: true,
          },
        },
        { upsert: true, new: true }
      );

      // Test connection
      const manager = new IntegrationManager(integration);
      const testResult = await manager.testConnection();

      if (!testResult.success) {
        await Integration.findByIdAndUpdate(integration._id, {
          status: "error",
          lastError: {
            message: testResult.errorMessage,
            occurredAt: new Date(),
            code: "CONNECTION_TEST_FAILED",
          },
        });

        return ErrorResponse(res, status.BAD_REQUEST, {
          message: `Connection failed: ${testResult.errorMessage}`,
        });
      }

      // Mark as connected
      await Integration.findByIdAndUpdate(integration._id, {
        status: "connected",
        lastError: null,
      });

      // Generate webhook URL for customer to configure in CRM
      const webhookUrl = `${process.env.API_URL}/webhook/${provider}?secret=${integration.webhookSecret}`;

      return SuccessResponse(res, status.OK, {
        message: `${provider} connected successfully`,
        data: {
          provider,
          status: "connected",
          webhookUrl, // Customer needs to add this in JobNimbus settings
          accountName: testResult.accountName,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /integrations/disconnect
   * Disconnect a CRM integration
   * Body: { provider: "jobnimbus" }
   */
  public static async disconnect(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const companyId = req.user.companies?.[0]?.companyId;
      const { provider } = req.body;

      await Integration.findOneAndUpdate(
        { companyId, provider },
        {
          status: "disconnected",
          "credentials.apiKey": null,
        }
      );

      return SuccessResponse(res, status.OK, {
        message: `${provider} disconnected`,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /integrations/settings
   * Update integration settings
   * Body: { provider: "jobnimbus", inboundSyncEnabled: true, outboundSyncEnabled: false }
   */
  public static async updateSettings(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const companyId = req.user.companies?.[0]?.companyId;
      const { provider, inboundSyncEnabled, outboundSyncEnabled } = req.body;

      const update: any = {};
      if (typeof inboundSyncEnabled === "boolean") {
        update["settings.inboundSyncEnabled"] = inboundSyncEnabled;
      }
      if (typeof outboundSyncEnabled === "boolean") {
        update["settings.outboundSyncEnabled"] = outboundSyncEnabled;
      }

      const integration = await Integration.findOneAndUpdate(
        { companyId, provider },
        update,
        { new: true }
      );

      if (!integration) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Integration not found",
        });
      }

      return SuccessResponse(res, status.OK, {
        message: "Settings updated",
        data: {
          provider: integration.provider,
          settings: integration.settings,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /integrations/test
   * Test integration connection
   * Body: { provider: "jobnimbus" }
   */
  public static async testConnection(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const companyId = req.user.companies?.[0]?.companyId;
      const { provider } = req.body;

      const integration = await Integration.findOne({ companyId, provider });
      if (!integration) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Integration not found",
        });
      }

      const manager = new IntegrationManager(integration);
      const result = await manager.testConnection();

      if (result.success) {
        await Integration.findByIdAndUpdate(integration._id, {
          status: "connected",
          lastError: null,
        });
      } else {
        await Integration.findByIdAndUpdate(integration._id, {
          status: "error",
          lastError: {
            message: result.errorMessage,
            occurredAt: new Date(),
            code: "CONNECTION_TEST_FAILED",
          },
        });
      }

      return SuccessResponse(res, status.OK, {
        message: result.success ? "Connection successful" : "Connection failed",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /integrations/sync-history
   * Get recent sync jobs for debugging
   */
  public static async getSyncHistory(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const companyId = req.user.companies?.[0]?.companyId;
      const { provider, limit = 20 } = req.query;

      const integration = await Integration.findOne({ companyId, provider });
      if (!integration) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Integration not found",
        });
      }

      const jobs = await SyncJob.find({ integrationId: integration._id })
        .sort({ createdAt: -1 })
        .limit(Number(limit))
        .lean();

      return SuccessResponse(res, status.OK, {
        message: "Sync history retrieved",
        data: jobs,
      });
    } catch (error) {
      next(error);
    }
  }
}
```

### Router (`lib/routes/integrations/index.ts`)

```typescript
import * as express from "express";
import { IntegrationRoutes } from "./routes";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/auth";

export class IntegrationRouter {
  router: express.Router;

  constructor() {
    this.router = express.Router();

    // All integration routes require authentication + admin role
    this.router.use(authMiddleware);
    this.router.use(adminMiddleware);

    this.router.get("/status", IntegrationRoutes.getStatus);
    this.router.post("/connect", IntegrationRoutes.connect);
    this.router.post("/disconnect", IntegrationRoutes.disconnect);
    this.router.patch("/settings", IntegrationRoutes.updateSettings);
    this.router.post("/test", IntegrationRoutes.testConnection);
    this.router.get("/sync-history", IntegrationRoutes.getSyncHistory);
  }
}
```

---

## Sync Flows

### Inbound Sync: CRM Job → CrewCam Project

```
JobNimbus                    CrewCam
    │                           │
    │  POST /webhook/jobnimbus  │
    │ ─────────────────────────▶│
    │                           │
    │                           ├─▶ Verify webhook secret
    │                           │
    │                           ├─▶ Check idempotency (ProcessedWebhook)
    │                           │
    │                           ├─▶ Parse event, extract job ID
    │                           │
    │                           ├─▶ Return 200 immediately
    │                           │
    │   200 OK                  │
    │ ◀─────────────────────────│
    │                           │
    │                           │   (Async processing)
    │                           │
    │                           ├─▶ Create SyncJob (pending)
    │                           │
    │   GET /api1/jobs/{id}     │
    │ ◀─────────────────────────│
    │                           │
    │   Job details             │
    │ ─────────────────────────▶│
    │                           │
    │                           ├─▶ Check duplicate (external_id exists?)
    │                           │
    │                           ├─▶ Create Project with externalMapping
    │                           │
    │                           ├─▶ Mark SyncJob completed
    │                           │
    │                           ├─▶ Update Integration.lastSuccessfulSync
```

### Outbound Sync: Photo → CRM

```
Mobile App                  CrewCam                     JobNimbus
    │                          │                            │
    │  Upload Photo            │                            │
    │ ────────────────────────▶│                            │
    │                          │                            │
    │                          ├─▶ Save to S3               │
    │                          │                            │
    │                          ├─▶ Create Post record       │
    │                          │                            │
    │                          ├─▶ Check: Project has       │
    │                          │   externalMapping?         │
    │                          │                            │
    │                          ├─▶ Check: outboundSync      │
    │                          │   enabled?                 │
    │                          │                            │
    │  200 OK                  │                            │
    │ ◀────────────────────────│                            │
    │                          │                            │
    │                          │   (Async processing)       │
    │                          │                            │
    │                          ├─▶ Create SyncJob (pending) │
    │                          │                            │
    │                          │   POST /api1/files         │
    │                          │ ──────────────────────────▶│
    │                          │                            │
    │                          │   201 Created              │
    │                          │ ◀──────────────────────────│
    │                          │                            │
    │                          ├─▶ Mark SyncJob completed   │
    │                          │                            │
    │                          ├─▶ Update Project           │
    │                          │   lastOutboundSync         │
```

---

## Error Handling & Retries

### Retry Strategy

```typescript
// lib/integrations/syncService.ts

const RETRY_DELAYS = [
  30 * 1000,        // 30 seconds
  2 * 60 * 1000,    // 2 minutes
  8 * 60 * 1000,    // 8 minutes
  32 * 60 * 1000,   // 32 minutes
  2 * 60 * 60 * 1000, // 2 hours
];

export async function processWithRetry(syncJob: ISyncJob): Promise<void> {
  try {
    // Process the job...
    await processSyncJob(syncJob);

    // Success
    await SyncJob.findByIdAndUpdate(syncJob._id, {
      status: "completed",
      result: { success: true },
    });

  } catch (error) {
    const attempts = syncJob.attempts + 1;

    if (attempts >= syncJob.maxAttempts) {
      // Final failure
      await SyncJob.findByIdAndUpdate(syncJob._id, {
        status: "failed",
        attempts,
        lastAttemptAt: new Date(),
        result: {
          success: false,
          errorMessage: error.message,
        },
      });

      // Update integration with last error
      await Integration.findByIdAndUpdate(syncJob.integrationId, {
        lastError: {
          message: error.message,
          occurredAt: new Date(),
          code: "SYNC_FAILED",
        },
      });

    } else {
      // Schedule retry
      const delay = RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];

      await SyncJob.findByIdAndUpdate(syncJob._id, {
        status: "pending",
        attempts,
        lastAttemptAt: new Date(),
        nextRetryAt: new Date(Date.now() + delay),
      });
    }
  }
}
```

### Error Surfacing

Errors are exposed through:

1. **Integration.lastError** - Most recent error for UI display
2. **SyncJob.result.errorMessage** - Per-job errors for debugging
3. **GET /integrations/sync-history** - Full job history

---

## Adding a New CRM Provider

To add Roofr (or any other CRM):

### Step 1: Create Provider File

Create `lib/integrations/providers/roofr.ts`:

```typescript
import { BaseProvider, ExternalProject, PhotoUploadPayload, PhotoUploadResult, ConnectionTestResult, WebhookEvent } from "./base";

export class RoofrProvider extends BaseProvider {
  readonly providerName = "roofr";
  readonly displayName = "Roofr";
  readonly apiBaseUrl = "https://api.roofr.com/v1"; // Verify actual URL

  async testConnection(): Promise<ConnectionTestResult> {
    // Implement Roofr-specific connection test
  }

  parseWebhook(headers: Record<string, string>, body: any): WebhookEvent | null {
    // Implement Roofr webhook parsing
  }

  verifyWebhookSignature(headers: Record<string, string>, body: any): boolean {
    // Implement Roofr signature verification
  }

  async getProject(externalId: string): Promise<ExternalProject | null> {
    // Implement Roofr project fetching
  }

  async uploadPhoto(externalProjectId: string, photo: PhotoUploadPayload): Promise<PhotoUploadResult> {
    // Implement Roofr photo upload
  }

  getProjectUrl(externalId: string): string {
    return `https://app.roofr.com/projects/${externalId}`;
  }
}
```

### Step 2: Register Provider

Update `lib/integrations/manager.ts`:

```typescript
import { JobNimbusProvider } from "./providers/jobnimbus";
import { RoofrProvider } from "./providers/roofr";

const PROVIDERS = {
  jobnimbus: JobNimbusProvider,
  roofr: RoofrProvider,
};
```

### Step 3: Add Webhook Route

Update `lib/routes/webhooks/index.ts`:

```typescript
this.router.post("/roofr", WebhookRoutes.roofrWebhook);
```

### Step 4: Add to Enum

Update `lib/db/integration.ts`:

```typescript
export const INTEGRATION_PROVIDERS = ["jobnimbus", "roofr", "acculynx"] as const;
```

**That's it.** All sync logic, retry handling, error tracking, and settings management is inherited.

---

## Implementation Checklist

### Phase 1: Data Models & Infrastructure
- [ ] Create `lib/db/integration.ts`
- [ ] Create `lib/db/syncJob.ts`
- [ ] Create `lib/db/processedWebhook.ts`
- [ ] Update `lib/db/projects.ts` with externalMapping
- [ ] Update `lib/db/index.ts` to export new models
- [ ] Create `lib/integrations/` directory structure
- [ ] Create `lib/integrations/types.ts`
- [ ] Create `lib/integrations/providers/base.ts`
- [ ] Create `lib/integrations/manager.ts`

### Phase 2: JobNimbus Provider
- [ ] Create `lib/integrations/providers/jobnimbus.ts`
- [ ] Implement `testConnection()`
- [ ] Implement `parseWebhook()`
- [ ] Implement `getProject()`
- [ ] Implement `uploadPhoto()`

### Phase 3: API Routes
- [ ] Create `lib/routes/integrations/routes.ts`
- [ ] Create `lib/routes/integrations/index.ts`
- [ ] Add integration routes to main router (`lib/index.ts`)
- [ ] Add webhook route for JobNimbus

### Phase 4: Sync Logic
- [ ] Create `lib/integrations/syncService.ts`
- [ ] Implement inbound sync (webhook → project)
- [ ] Implement outbound sync hook (photo → CRM)
- [ ] Add retry logic with exponential backoff
- [ ] Hook into post creation flow (`lib/routes/posts/routes.ts`)

### Phase 5: Testing & Polish
- [ ] Test with real JobNimbus account
- [ ] Test inbound sync (create job in JN → verify project created)
- [ ] Test outbound sync (upload photo → verify in JN)
- [ ] Test error handling and retries
- [ ] Test duplicate prevention

---

## Environment Variables

Add to `.env.example`:

```bash
# Integrations
# (No global config needed - credentials stored per workspace in database)
```

---

## Frontend Requirements

The frontend needs to implement:

1. **Settings Page** (`/settings/integrations`)
   - List available integrations (JobNimbus, coming soon: Roofr)
   - Connect button → modal with API key input
   - Disconnect button
   - Toggle switches for inbound/outbound sync
   - Status indicator (connected/disconnected/error)
   - Last sync timestamp
   - Last error message (if any)

2. **Webhook URL Display**
   - After connecting, show webhook URL for user to add to JobNimbus

### API Endpoints for Frontend

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/integrations/status` | GET | Get all integration statuses |
| `/integrations/connect` | POST | Connect new integration |
| `/integrations/disconnect` | POST | Disconnect integration |
| `/integrations/settings` | PATCH | Update sync toggles |
| `/integrations/test` | POST | Test connection |
| `/integrations/sync-history` | GET | Get recent sync jobs |

---

## Questions for Product/Engineering Review

1. **Webhook URL Setup**: JobNimbus requires customers to manually add webhook URL in their settings. Is this acceptable UX, or do we need in-app instructions/guide?

2. **Photo Selection**: Should ALL photos sync, or only photos with specific tags? Current design syncs all.

3. **Historical Sync**: When integration is first connected, should we backfill existing JobNimbus jobs as CrewCam projects? Current design is forward-only.

4. **Rate Limiting**: JobNimbus rate limits are unclear. Should we add configurable throttling?

5. **Encryption**: API keys are stored as plain text. Should we add encryption at rest? (Recommendation: Yes, but can be Phase 2)
