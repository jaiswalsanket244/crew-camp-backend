import { createClient, RedisClientType } from "redis";
import { config } from "../../utils/configuration/config";

class RedisService {
  private client: RedisClientType | null = null;
  private isConnected: boolean = false;

  constructor() {
    // Initialize Redis client if REDIS_URL is configured
    if (config.REDIS_URL) {
      this.initializeClient();
    }
  }

  private initializeClient() {
    try {
      if (!config.REDIS_URL) {
        throw new Error("Redis: REDIS_URL not configured");
      }

      // Log connection info (without password)
      const safeUrl = config.REDIS_URL.replace(/:([^:@]+)@/, ":***@");
      console.log(`Redis: Connecting to ${safeUrl}`);

      // Create Redis client with configuration
      this.client = createClient({
        url: config.REDIS_URL,
        socket: {
          connectTimeout: 10000,
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.error("Redis: Max reconnection attempts reached");
              return new Error("Too many retries");
            }
            // Exponential backoff: wait 2^retries * 100ms, max 5 seconds
            const delay = Math.min(Math.pow(2, retries) * 100, 5000);
            console.log(
              `Redis: Reconnecting attempt ${retries}, waiting ${delay}ms`,
            );
            return delay;
          },
        },
      });

      // Set up event handlers
      this.setupEventHandlers();
    } catch (error) {
      console.error("Redis: Failed to initialize client:", error);
    }
  }

  private setupEventHandlers() {
    if (!this.client) return;

    this.client.on("connect", () => {
      console.log("Redis: Client connected");
    });

    this.client.on("ready", () => {
      console.log("Redis: Client ready");
      this.isConnected = true;
    });

    this.client.on("error", (error) => {
      console.error("Redis: Client error:", error);
      this.isConnected = false;
    });

    this.client.on("end", () => {
      console.log("Redis: Client disconnected");
      this.isConnected = false;
    });

    this.client.on("reconnecting", () => {
      console.log("Redis: Client reconnecting");
      this.isConnected = false;
    });
  }

  public async connect(): Promise<void> {
    if (!this.client) {
      console.warn("Redis: No client configured, skipping connection");
      return;
    }

    if (this.isConnected) {
      console.log("Redis: Already connected");
      return;
    }

    try {
      await this.client.connect();
      console.log("Redis: Successfully connected");
    } catch (error) {
      console.error("Redis: Connection failed:", error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      await this.client.quit();
      console.log("Redis: Disconnected");
    } catch (error) {
      console.error("Redis: Disconnect error:", error);
      // Force disconnect if quit fails
      await this.client.disconnect();
    }
  }

  public getClient(): RedisClientType | null {
    if (!this.isConnected || !this.client) {
      console.warn("Redis: Client not connected");
      return null;
    }
    return this.client;
  }

  public isReady(): boolean {
    return this.isConnected && this.client !== null;
  }

  // Basic operations wrapper methods
  public async get(key: string): Promise<string | null> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for get operation");
      return null;
    }
    try {
      const result = await this.client!.get(key);
      return typeof result === "string" ? result : null;
    } catch (error) {
      console.error(`Redis: Error getting key ${key}:`, error);
      return null;
    }
  }

  public async set(key: string, value: string, ttl?: number): Promise<boolean> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for set operation");
      return false;
    }
    try {
      if (ttl) {
        await this.client!.setEx(key, ttl, value);
      } else {
        await this.client!.set(key, value);
      }
      return true;
    } catch (error) {
      console.error(`Redis: Error setting key ${key}:`, error);
      return false;
    }
  }

  public async del(key: string): Promise<boolean> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for del operation");
      return false;
    }
    try {
      const result = await this.client!.del(key);
      return result > 0;
    } catch (error) {
      console.error(`Redis: Error deleting key ${key}:`, error);
      return false;
    }
  }

  public async exists(key: string): Promise<boolean> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for exists operation");
      return false;
    }
    try {
      const result = await this.client!.exists(key);
      return result > 0;
    } catch (error) {
      console.error(`Redis: Error checking key ${key}:`, error);
      return false;
    }
  }

  public async expire(key: string, seconds: number): Promise<boolean> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for expire operation");
      return false;
    }
    try {
      const result = await this.client!.expire(key, seconds);
      return Boolean(result);
    } catch (error) {
      console.error(`Redis: Error setting expiry for key ${key}:`, error);
      return false;
    }
  }

  // Hash operations
  public async hSet(
    key: string,
    field: string,
    value: string,
  ): Promise<boolean> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for hSet operation");
      return false;
    }
    try {
      await this.client!.hSet(key, field, value);
      return true;
    } catch (error) {
      console.error(`Redis: Error setting hash field ${key}.${field}:`, error);
      return false;
    }
  }

  public async hGet(key: string, field: string): Promise<string | null> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for hGet operation");
      return null;
    }
    try {
      const result = await this.client!.hGet(key, field);
      return typeof result === "string" ? result : null;
    } catch (error) {
      console.error(`Redis: Error getting hash field ${key}.${field}:`, error);
      return null;
    }
  }

  public async hGetAll(key: string): Promise<Record<string, string> | null> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for hGetAll operation");
      return null;
    }
    try {
      return await this.client!.hGetAll(key);
    } catch (error) {
      console.error(`Redis: Error getting hash ${key}:`, error);
      return null;
    }
  }

  // List operations
  public async lPush(key: string, ...values: string[]): Promise<boolean> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for lPush operation");
      return false;
    }
    try {
      await this.client!.lPush(key, values);
      return true;
    } catch (error) {
      console.error(`Redis: Error pushing to list ${key}:`, error);
      return false;
    }
  }

  public async lRange(
    key: string,
    start: number,
    stop: number,
  ): Promise<string[]> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for lRange operation");
      return [];
    }
    try {
      return await this.client!.lRange(key, start, stop);
    } catch (error) {
      console.error(`Redis: Error getting list range ${key}:`, error);
      return [];
    }
  }

  // Set operations
  public async sAdd(key: string, ...members: string[]): Promise<boolean> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for sAdd operation");
      return false;
    }
    try {
      await this.client!.sAdd(key, members);
      return true;
    } catch (error) {
      console.error(`Redis: Error adding to set ${key}:`, error);
      return false;
    }
  }

  public async sMembers(key: string): Promise<string[]> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for sMembers operation");
      return [];
    }
    try {
      return await this.client!.sMembers(key);
    } catch (error) {
      console.error(`Redis: Error getting set members ${key}:`, error);
      return [];
    }
  }

  // Utility method to clear all keys (use with caution)
  public async flushDb(): Promise<boolean> {
    if (!this.isReady()) {
      console.warn("Redis: Not ready for flushDb operation");
      return false;
    }
    try {
      await this.client!.flushDb();
      console.log("Redis: Database flushed");
      return true;
    } catch (error) {
      console.error("Redis: Error flushing database:", error);
      return false;
    }
  }
}

// Export singleton instance
export const redisService = new RedisService();

// Also export the connection function for use in server startup
export const connectRedis = async (): Promise<void> => {
  try {
    await redisService.connect();
  } catch (error) {
    console.error("Redis connection error:", error);
    // Don't throw - allow server to start without Redis
    console.warn("Server starting without Redis cache");
  }
};
