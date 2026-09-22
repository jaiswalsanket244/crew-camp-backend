/**
 * Project-related Integration Hooks
 *
 * Functions to hook into project operations and trigger sync.
 * These are called from existing routes/helpers after successful operations.
 */

import mongoose from "mongoose";
import { Integration, Project, Tags } from "../../db";
import {
  CreateProjectPayload,
  UpdateProjectPayload,
} from "../../utils/interfaces/integrations";
import { JobNimbusProvider } from "../providers/jobnimbus";
import { BaseProvider } from "../providers/base";
import { EncryptionService } from "../../services/encryption";
import { IIntegration } from "../../db/integration";
import { parseAddressWithGeocoding } from "../../services/geocodingService";

/**
 * Result of syncing to a single provider
 */
interface ProviderSyncResult {
  provider: string;
  success: boolean;
  externalId?: string;
  externalUrl?: string;
  errorMessage?: string;
}

/**
 * Helper: Parse address string into structured format
 * Uses geocoding service for intelligent parsing with fallback
 */
async function parseAddress(location: string): Promise<
  | {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      zip?: string;
    }
  | undefined
> {
  if (!location) return undefined;

  // Use the simple parser from geocoding service
  // TODO: For more accurate parsing, use parseAddressWithGeocoding() with Google Maps API
  const parsedLocation = await parseAddressWithGeocoding(location);
  return parsedLocation;
}

/**
 * Helper: Create provider instance based on integration type
 */
function createProviderInstance(
  integration: any, // Mongoose document
): BaseProvider | null {
  // Decrypt the API key before passing to provider
  const decryptedIntegration: IIntegration = {
    ...integration.toObject(),
    credentials: {
      apiKey: EncryptionService.decrypt(integration.credentials.apiKey),
    },
  } as IIntegration;

  // Instantiate the correct provider class
  switch (integration.provider) {
    case "jobnimbus":
      return new JobNimbusProvider(decryptedIntegration);
    case "proline":
    case "roofr":
    case "acculynx":
      // These providers don't support outbound project create/update yet.
      // Proline is inbound-only: its webhook creates/updates CrewCam projects,
      // but CrewCam does not push projects back to Proline.
      return null;
    default:
      return null;
  }
}

/**
 * Helper: Prepare customer data for external CRM
 */
function prepareCustomerData(customer?: {
  name?: string;
  email?: string;
  phone?: string;
}):
  | { firstName?: string; lastName?: string; email?: string; phone?: string }
  | undefined {
  if (!customer) return undefined;

  return {
    firstName: customer.name?.split(" ")[0],
    lastName: customer.name?.split(" ").slice(1).join(" "),
    email: customer.email,
    phone: customer.phone,
  };
}

/**
 * Helper: Prepare geo coordinates for external CRM
 */
function prepareGeoData(coordinates?: {
  latitude?: number;
  longitude?: number;
}): { lat?: number; lon?: number } | undefined {
  if (!coordinates?.latitude || !coordinates?.longitude) return undefined;

  return {
    lat: coordinates.latitude,
    lon: coordinates.longitude,
  };
}

/**
 * Hook called after a project is created.
 * Creates the project in all connected external CRM systems with outbound sync enabled.
 *
 * @param projectId - The ID of the created project
 * @param requestedProvider - Optional specific provider to sync with (e.g., 'jobnimbus')
 * @returns Object with overall success status and results per provider
 */
export async function onProjectCreated(
  projectId: mongoose.Types.ObjectId | string,
  requestedProvider?: string,
): Promise<{
  success: boolean;
  results: ProviderSyncResult[];
  externalId?: string;
  externalUrl?: string;
}> {
  try {
    // Fetch the project data
    const project = await Project.findById(projectId);

    if (!project) {
      return { success: false, results: [] };
    }

    // Find ALL active integrations for this workspace
    const query: any = {
      companyId: project.companyId,
      status: "connected",
      "settings.outboundSyncEnabled": true,
    };

    // If specific provider is requested, filter by it
    if (requestedProvider) {
      query.provider = requestedProvider;
    }

    const integrations = await Integration.find(query);

    if (!integrations || integrations.length === 0) {
      return { success: false, results: [] };
    }

    // Fetch the tags assigned to the project
    const tags = await Tags.find(
      { _id: { $in: project.tags || [] } },
      { tag: 1 },
    );

    // Prepare the project payload for external CRM (used for all providers)
    const projectPayload: CreateProjectPayload = {
      _id: project._id.toString(), // Store CrewCam project ID for reference
      name: project.name,
      description: project.description,
      address: await parseAddress(project.location as string),
      customer: prepareCustomerData((project as any).customer),
      geo: prepareGeoData(project.coordinates),
      status: project.status || "Active",
      tags: tags.map((t) => t.tag), // Send tag names as string array
    };

    // Sync to all integrations
    const results: ProviderSyncResult[] = [];
    let overallSuccess = false;
    let primaryExternalId: string | undefined;
    let primaryExternalUrl: string | undefined;

    for (const integration of integrations) {
      try {
        // Create the appropriate provider instance
        const providerInstance = createProviderInstance(integration);

        if (!providerInstance) {
          results.push({
            provider: integration.provider,
            success: false,
            errorMessage: `Provider ${integration.provider} does not support project operations`,
          });
          continue;
        }

        // Check if provider supports project creation
        if (!providerInstance.createProject) {
          results.push({
            provider: integration.provider,
            success: false,
            errorMessage: "Provider does not support project creation",
          });
          continue;
        }

        // Create the project in external CRM
        const result = await providerInstance.createProject(projectPayload);

        if (result.success && result.externalId) {
          // Update the project with external mapping
          // Note: Currently only stores one mapping - consider updating schema to support multiple
          await Project.findByIdAndUpdate(project._id, {
            externalMapping: {
              system: integration.provider,
              externalId: result.externalId,
              externalUrl: result.externalUrl,
              syncedAt: new Date(),
            },
          });

          results.push({
            provider: integration.provider,
            success: true,
            externalId: result.externalId,
            externalUrl: result.externalUrl,
          });

          // Set primary external ID (first successful one)
          if (!primaryExternalId) {
            primaryExternalId = result.externalId;
            primaryExternalUrl = result.externalUrl;
          }

          overallSuccess = true;
        } else {
          results.push({
            provider: integration.provider,
            success: false,
            errorMessage: result.errorMessage,
          });
        }
      } catch (error) {
        results.push({
          provider: integration.provider,
          success: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      success: overallSuccess,
      results,
      externalId: primaryExternalId,
      externalUrl: primaryExternalUrl,
    };
  } catch (error) {
    // Log error but don't throw - integration failures shouldn't block core operations
    return { success: false, results: [] };
  }
}

/**
 * Hook called after a project is updated.
 * Updates the project in all connected external CRM systems with outbound sync enabled.
 *
 * @param projectId - The ID of the updated project
 * @param requestedProvider - Optional specific provider to sync with (e.g., 'jobnimbus')
 * @returns Object with overall success status and results per provider
 */
export async function onProjectUpdated(
  projectId: mongoose.Types.ObjectId | string,
  requestedProvider?: string,
): Promise<{
  success: boolean;
  results: ProviderSyncResult[];
  externalId?: string;
  externalUrl?: string;
}> {
  try {
    // Fetch the project data
    const project = await Project.findById(projectId);

    if (!project) {
      return { success: false, results: [] };
    }

    // Check if project has external mapping
    if (!project.externalMapping?.externalId) {
      return { success: false, results: [] };
    }

    //fetch the tags assigned to the project
    const tags = await Tags.find(
      { _id: { $in: project.tags || [] } },
      { tag: 1 },
    );

    // Find ALL active integrations for this workspace
    const query: any = {
      companyId: project.companyId,
      status: "connected",
      "settings.outboundSyncEnabled": true,
    };

    // If specific provider is requested, filter by it
    if (requestedProvider) {
      query.provider = requestedProvider;
    }

    const integrations = await Integration.find(query);

    if (!integrations || integrations.length === 0) {
      return { success: false, results: [] };
    }

    // Sync to all integrations
    const results: ProviderSyncResult[] = [];
    let overallSuccess = false;
    let primaryExternalId: string | undefined;
    let primaryExternalUrl: string | undefined;

    for (const integration of integrations) {
      try {
        // Create the appropriate provider instance
        const providerInstance = createProviderInstance(integration);

        if (!providerInstance) {
          results.push({
            provider: integration.provider,
            success: false,
            errorMessage: `Provider ${integration.provider} does not support project operations`,
          });
          continue;
        }

        // Check if provider supports project updates
        if (!providerInstance.updateProject) {
          results.push({
            provider: integration.provider,
            success: false,
            errorMessage: "Provider does not support project updates",
          });
          continue;
        }

        // Prepare the project update payload for external CRM
        const updatePayload: UpdateProjectPayload = {
          externalId: project.externalMapping.externalId,
          name: project.name,
          description: project.description,
          address: await parseAddress(project.location as string),
          customer: prepareCustomerData((project as any).customer),
          geo: prepareGeoData(project.coordinates),
          status: project.status || "Active",
          tags: tags.map((t) => t.tag), // Send tag names as string array
          is_archived: !!project.archivedAt,
        };

        // Update the project in external CRM
        const result = await providerInstance.updateProject(updatePayload);

        if (result.success && result.externalId) {
          // Update the syncedAt timestamp
          await Project.findByIdAndUpdate(project._id, {
            "externalMapping.syncedAt": new Date(),
          });

          results.push({
            provider: integration.provider,
            success: true,
            externalId: result.externalId,
            externalUrl: result.externalUrl,
          });

          // Set primary external ID (first successful one)
          if (!primaryExternalId) {
            primaryExternalId = result.externalId;
            primaryExternalUrl = result.externalUrl;
          }

          overallSuccess = true;
        } else {
          results.push({
            provider: integration.provider,
            success: false,
            errorMessage: result.errorMessage,
          });
        }
      } catch (error) {
        results.push({
          provider: integration.provider,
          success: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      success: overallSuccess,
      results,
      externalId: primaryExternalId,
      externalUrl: primaryExternalUrl,
    };
  } catch (error) {
    // Log error but don't throw - integration failures shouldn't block core operations
    return { success: false, results: [] };
  }
}
