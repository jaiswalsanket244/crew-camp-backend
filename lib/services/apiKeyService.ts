import * as crypto from "crypto";
import { ApiKey } from "../db";

export class ApiKeyService {
  static generateKeyId(): string {
    return `ck_${crypto.randomBytes(16).toString("hex")}`;
  }

  static generateKeySecret(): string {
    return `cs_${crypto.randomBytes(32).toString("hex")}`;
  }

  static async validateApiKey(keyId: string, keySecret: string) {
    if (!keyId || !keySecret) {
      return null;
    }

    const hashedSecret = crypto
      .createHash("sha256")
      .update(keySecret)
      .digest("hex");

    const apiKey = await ApiKey.findOne({
      keyId,
      keySecret: hashedSecret,
      isActive: true,
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } },
      ],
    }).populate("userId");

    if (apiKey) {
      apiKey.lastUsed = new Date();
      await apiKey.save();
    }

    return apiKey;
  }
  static async validateApiKeyWithId(keyId: string) {
    if (!keyId) {
      return null;
    }

    const apiKey = await ApiKey.findOne({
      keyId,
      isActive: true,
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } },
      ],
    });

    if (apiKey) {
      apiKey.lastUsed = new Date();
      await apiKey.save();
    }

    return apiKey;
  }

  static async createHashedSecret(keySecret: string): Promise<string> {
    return crypto.createHash("sha256").update(keySecret).digest("hex");
  }
}
