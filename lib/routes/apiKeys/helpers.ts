import { ApiKey } from "../../db";
import { ApiKeyService } from "../../services/apiKeyService";
import { Types } from "mongoose";
export class ApiKeysHelper {
  public static async createApiKey(
    companyId: string,
    userId: string,
    name: string,
    expiresAt?: Date,
  ) {
    const keyId = ApiKeyService.generateKeyId();
    const keySecret = ApiKeyService.generateKeySecret();
    const apiKey = new ApiKey({
      keyId,
      keySecret: await ApiKeyService.createHashedSecret(keySecret),
      companyId,
      userId,
      name,
      isActive: true,
      expiresAt,
    });

    await apiKey.save();

    return {
      keyId,
      keySecret,
      name,
      expiresAt,
    };
  }

  public static async getUserApiKeys(companyId: Types.ObjectId) {
    return ApiKey.find(
      {
        companyId,
      },
      { keyId: 1, name: 1, createdAt: 1, isActive: 1 },
    )
      .select("-keySecret")
      .sort({ createdAt: -1 });
  }

  public static async updateApiKey(keyId: string, companyId: Types.ObjectId) {
    const apiKey = await ApiKey.findOne({ keyId, companyId });
    if (!apiKey) throw new Error("API key not found");

    apiKey.isActive = !apiKey.isActive;
    return apiKey.save();
  }

  public static async deleteApiKey(keyId: string, companyId: Types.ObjectId) {
    return ApiKey.deleteOne({ keyId, companyId: companyId });
  }
}
