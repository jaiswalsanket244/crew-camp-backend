import * as crypto from "crypto";
import { config } from "../utils/configuration/config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encryption service for sensitive data (API keys, credentials).
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Requires ENCRYPTION_KEY environment variable (32-byte hex string).
 */
export class EncryptionService {
  private static getKey(): Buffer {
    const key = config.ENCRYPTION_KEY;
    if (!key) {
      throw new Error(
        "ENCRYPTION_KEY environment variable is required for credential encryption",
      );
    }
    // Key should be 64 hex chars (32 bytes)
    if (key.length !== 64) {
      throw new Error(
        "ENCRYPTION_KEY must be a 64-character hex string (32 bytes)",
      );
    }
    return Buffer.from(key, "hex");
  }

  /**
   * Encrypt a plaintext string.
   * Returns format: iv:authTag:ciphertext (all hex encoded)
   */
  static encrypt(plaintext: string): string {
    if (!plaintext) {
      return plaintext;
    }

    const key = this.getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:ciphertext
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  }

  /**
   * Decrypt an encrypted string.
   * Expects format: iv:authTag:ciphertext (all hex encoded)
   */
  static decrypt(encryptedData: string): string {
    if (!encryptedData) {
      return encryptedData;
    }

    // Check if data is in encrypted format
    const parts = encryptedData.split(":");
    if (parts.length !== 3) {
      // Not encrypted (legacy data), return as-is
      return encryptedData;
    }

    const [ivHex, authTagHex, ciphertext] = parts;

    const key = this.getKey();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Check if a string appears to be encrypted.
   */
  static isEncrypted(data: string): boolean {
    if (!data) return false;
    const parts = data.split(":");
    // Check format: 32 hex chars : 32 hex chars : variable hex
    return (
      parts.length === 3 &&
      parts[0].length === IV_LENGTH * 2 &&
      parts[1].length === AUTH_TAG_LENGTH * 2
    );
  }

  /**
   * Generate a new encryption key (for initial setup).
   * Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   */
  static generateKey(): string {
    return crypto.randomBytes(32).toString("hex");
  }
}
