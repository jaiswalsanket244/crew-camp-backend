/**
 * Integration API Routes
 *
 * Endpoints for managing CRM integrations.
 */

import { Response, NextFunction } from "express";
import * as status from "http-status";
import * as crypto from "crypto";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { Integration, SyncJob } from "../../db";
import {
  createIntegrationManager,
  PROVIDER_INFO,
  isProviderAvailable,
} from "../../integrations/manager";
import { config } from "../../utils/configuration/config";
import { EncryptionService } from "../../services/encryption";
import { IntegrationHelper } from "./helper";
import { Validator } from "node-input-validator";
import { ObjectId } from "../../utils/helpers/commonHelper";
import { INTEGRATION_STATUS } from "../../utils/enums/integrations";
import { CompanyCamImporter } from "../../integrations/providers/companyCam";

export class IntegrationRoutes {
  /**
   * GET /integrations/providers
   * List available integration providers.
   */
  public static async getProviders(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const providers = Object.entries(PROVIDER_INFO).map(([key, value]) => ({
        id: key,
        ...value,
      }));

      return SuccessResponse(res, status.OK, {
        message: "Providers retrieved",
        data: providers,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /integrations/status
   * Get integration status for current workspace.
   */
  public static async getStatus(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companies?.[0]?.companyId;
      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      const integrations =
        await IntegrationHelper.getIntegrationsByCompanyId(companyId);

      const result = integrations.map((int) => ({
        id: int._id,
        name: int.name,
        provider: int.provider,
        status: int.status,
        settings: int.settings,
        lastSuccessfulSync: int.lastSuccessfulSync,
        lastError: int.lastError,
        webhookUrl: int.webhookSecret
          ? `${config.WEBHOOK_URL}/${int.provider}?secret=${int.webhookSecret}`
          : null,
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
   * Connect a CRM integration.
   * Body: { provider: "jobnimbus", apiKey: "..." }
   */
  public static async connect(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validator = new Validator(req.body, {
        name: "string|required",
        apiKey: "string|required",
        provider: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const companyId = req.user?.companies?.[0]?.companyId;
      const { provider, apiKey, name } = req.body;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }
      if (!provider || !apiKey) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Provider and API key are required",
        });
      }
      // Validate provider
      if (!isProviderAvailable(provider)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: `Provider '${provider}' is not available`,
        });
      }

      // Check if already connected
      const existing =
        await IntegrationHelper.getIntegrationByCompanyAndProvider(
          companyId,
          provider,
        );

      if (existing?.status === "connected") {
        return ErrorResponse(res, status.CONFLICT, {
          message: `${PROVIDER_INFO[provider].displayName} is already connected. Disconnect first to reconnect.`,
        });
      }

      // Create or update integration
      const webhookSecret = crypto.randomBytes(32).toString("hex");
      const encryptedApiKey = EncryptionService.encrypt(apiKey);

      const integration = await IntegrationHelper.createIntegration(
        name,
        companyId,
        provider,
        { apiKey: encryptedApiKey, webhookSecret },
        { inboundSyncEnabled: true, outboundSyncEnabled: true },
      );

      // Test connection
      const manager = createIntegrationManager(integration);
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

      // Generate webhook URL
      const webhookUrl = `${config.WEBHOOK_URL}/${provider}?secret=${webhookSecret}`;

      return SuccessResponse(res, status.OK, {
        message: `${PROVIDER_INFO[provider].displayName} connected successfully`,
        data: {
          provider,
          status: "connected",
          webhookUrl,
          accountName: testResult.accountName,
          instructions: `Add this webhook URL to your ${PROVIDER_INFO[provider].displayName} settings to enable automatic project sync.`,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /integrations/disconnect
   * Disconnect a CRM integration.
   * Body: { provider: "jobnimbus" }
   */
  public static async changeStatus(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companies?.[0]?.companyId;
      const id = req.params.id;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      if (!id) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Integration ID is required",
        });
      }

      const currentStatus = await IntegrationHelper.getCurrentStatus(
        ObjectId(id),
      );

      if (currentStatus) {
        await IntegrationHelper.changeIntegrationStatus(
          companyId,
          ObjectId(id),
          currentStatus.status === INTEGRATION_STATUS.connected
            ? INTEGRATION_STATUS.disconnected
            : INTEGRATION_STATUS.connected,
        );
      }

      return SuccessResponse(res, status.OK, {
        message: `disconnected successfully`,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /integrations/settings
   * Update integration settings.
   * Body: { provider: "jobnimbus", inboundSyncEnabled: true, outboundSyncEnabled: false }
   */
  public static async updateSettings(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companies?.[0]?.companyId;
      const { provider, inboundSyncEnabled, outboundSyncEnabled } = req.body;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      if (!provider) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Provider is required",
        });
      }

      const update: Record<string, unknown> = {};
      if (typeof inboundSyncEnabled === "boolean") {
        update["settings.inboundSyncEnabled"] = inboundSyncEnabled;
      }
      if (typeof outboundSyncEnabled === "boolean") {
        update["settings.outboundSyncEnabled"] = outboundSyncEnabled;
      }

      if (Object.keys(update).length === 0) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No settings provided to update",
        });
      }

      const integration = await Integration.findOneAndUpdate(
        { companyId, provider },
        update,
        { new: true },
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
   * Test integration connection.
   * Body: { provider: "jobnimbus" }
   */
  public static async testConnection(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companies?.[0]?.companyId;
      const { provider } = req.body;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      if (!provider) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Provider is required",
        });
      }

      const integration = await Integration.findOne({ companyId, provider });
      if (!integration) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Integration not found. Please connect first.",
        });
      }

      const manager = createIntegrationManager(integration);
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
   * Get recent sync jobs for debugging.
   * Query: { provider: "jobnimbus", limit: 20 }
   */
  public static async getSyncHistory(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companies?.[0]?.companyId;
      const { provider, limit = "20" } = req.query;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      if (!provider) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Provider is required",
        });
      }

      const integration = await Integration.findOne({
        companyId,
        provider: provider as string,
      });
      if (!integration) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Integration not found",
        });
      }

      const jobs = await SyncJob.find({ integrationId: integration._id })
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit), 100))
        .lean();

      const formattedJobs = jobs.map((job) => ({
        id: job._id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        result: job.result,
        createdAt: job.createdAt,
        lastAttemptAt: job.lastAttemptAt,
        nextRetryAt: job.nextRetryAt,
      }));

      return SuccessResponse(res, status.OK, {
        message: "Sync history retrieved",
        data: formattedJobs,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /integrations/retry
   * Retry a failed sync job.
   * Body: { jobId: "..." }
   */
  public static async retrySyncJob(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const companyId = req.user?.companies?.[0]?.companyId;
      const { jobId } = req.body;

      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      if (!jobId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Job ID is required",
        });
      }

      const job = await SyncJob.findById(jobId);
      if (!job) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Sync job not found",
        });
      }

      // Verify job belongs to user's workspace
      const integration = await Integration.findOne({
        _id: job.integrationId,
        companyId,
      });
      if (!integration) {
        return ErrorResponse(res, status.FORBIDDEN, {
          message: "Sync job does not belong to your workspace",
        });
      }

      // Reset job for retry
      await SyncJob.findByIdAndUpdate(jobId, {
        status: "pending",
        attempts: 0,
        nextRetryAt: null,
        result: null,
      });

      return SuccessResponse(res, status.OK, {
        message: "Sync job queued for retry",
        data: { jobId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /integrations/sync-tags
   * Push this workspace's project-tag vocabulary into the CRM.
   * Body: { provider: "proline" }
   *
   * Registers tag *names* so they become selectable in the CRM. Binding a tag
   * to a specific project is a separate, provider-dependent step.
   */
  public static async syncTagDefinitions(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validator = new Validator(req.body, {
        provider: "required|string",
      });

      if (!(await validator.check())) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const companyId = req.user?.companies?.[0]?.companyId;
      if (!companyId) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "No workspace found",
        });
      }

      const { provider } = req.body;

      const integration = await Integration.findOne({
        companyId,
        provider,
        status: INTEGRATION_STATUS.connected,
      });

      if (!integration) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Integration not found or not connected",
        });
      }

      const manager = createIntegrationManager(integration);

      if (!manager.supportsTagSync) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: `${manager.displayName} does not support tag sync`,
        });
      }

      const tagNames =
        await IntegrationHelper.getCompanyProjectTagNames(companyId);

      if (tagNames.length === 0) {
        return SuccessResponse(res, status.OK, {
          message: "No project tags to sync",
          data: { syncedTags: [] },
        });
      }

      const result = await manager.syncTagDefinitions(tagNames);

      if (!result.success) {
        await Integration.findByIdAndUpdate(integration._id, {
          lastError: {
            message: result.errorMessage,
            occurredAt: new Date(),
            code: "TAG_SYNC_FAILED",
          },
        });

        return ErrorResponse(res, status.BAD_GATEWAY, {
          message: `Tag sync failed: ${result.errorMessage}`,
        });
      }

      return SuccessResponse(res, status.OK, {
        message: `Synced ${result.syncedTags?.length || 0} tags to ${manager.displayName}`,
        data: { syncedTags: result.syncedTags || [] },
      });
    } catch (error) {
      next(error);
    }
  }

  public static async verifyDataFromCompanyCam(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validator = new Validator(req.body, {
        apiKey: "string|required",
        countryCode: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { apiKey, countryCode } = req.body;
      const importer = new CompanyCamImporter(apiKey, countryCode);

      const data = await importer.verifyUserData();

      return SuccessResponse(res, status.OK, {
        message: "Verified the API Key",
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  public static async importDataFromCompanyCam(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validator = new Validator(req.body, {
        apiKey: "string|required",
        countryCode: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }
      const { apiKey, countryCode } = req.body;
      const importer = new CompanyCamImporter(apiKey, countryCode);

      const data = await importer.importAllData();

      return SuccessResponse(res, status.OK, {
        message: "Sync job queued for retry",
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}
