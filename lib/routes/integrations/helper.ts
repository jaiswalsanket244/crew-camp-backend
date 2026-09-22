import mongoose from "mongoose";
import { Integration, Tags } from "../../db";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { INTEGRATION_STATUS } from "../../utils/enums/integrations";
import { CURRENT_TAGS, TAGS_FOR } from "../../utils/enums/enums";

export class IntegrationHelper {
  public static getIntegrationByCompanyAndProvider(
    companyId: string,
    provider: string,
  ) {
    return Integration.findOne({ companyId, provider });
  }

  /**
   * Distinct project-tag names for a company: its own custom tags plus the
   * global defaults, which is the vocabulary a CRM needs to mirror.
   */
  public static async getCompanyProjectTagNames(
    companyId: mongoose.Types.ObjectId | string,
  ): Promise<string[]> {
    const tags = await Tags.find(
      {
        tagFor: TAGS_FOR.PROJECT,
        $or: [
          { companyId, type: CURRENT_TAGS.CUSTOM },
          { type: CURRENT_TAGS.DEFAULT, companyId: { $exists: false } },
        ],
      },
      { tag: 1 },
    ).lean();

    return Array.from(
      new Set(
        tags
          .map((t) => (typeof t.tag === "string" ? t.tag.trim() : ""))
          .filter(Boolean),
      ),
    );
  }

  public static createIntegration(
    name: string,
    companyId: string,
    provider: string,
    credentials: { apiKey: string; webhookSecret: string },
    settings: { inboundSyncEnabled?: boolean; outboundSyncEnabled?: boolean },
  ) {
    return Integration.findOneAndUpdate(
      { companyId, provider },
      {
        name,
        companyId,
        provider,
        credentials,
        settings: {
          inboundSyncEnabled: settings.inboundSyncEnabled ?? true,
          outboundSyncEnabled: settings.outboundSyncEnabled ?? true,
        },
        webhookSecret: credentials.webhookSecret,
        status: "connected",
        lastSuccessfulSync: null,
        lastError: null,
      },
      { upsert: true, new: true },
    );
  }

  public static getIntegrationsByCompanyId(companyId: string) {
    return Integration.find({ companyId });
  }

  public static getCurrentStatus(id: ObjectIdType) {
    return Integration.findById(id, { status: 1 });
  }

  public static changeIntegrationStatus(
    companyId: string,
    id: ObjectIdType,
    status: INTEGRATION_STATUS,
  ) {
    return Integration.findOneAndUpdate(
      { companyId, _id: id },
      { $set: { status } },
      { new: true },
    );
  }
}
