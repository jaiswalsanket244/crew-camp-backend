import { redisService } from "./redisClient";

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  prefix?: string; // Key prefix for namespacing
}

interface CachedData<T> {
  data: T;
  timestamp: number;
}

class CacheService {
  private readonly defaultTTL = 3600; // 1 hour default
  private readonly keyPrefix = "crewcam:";

  /**
   * Generate a cache key with optional prefix
   */
  private generateKey(key: string, prefix?: string): string {
    const finalPrefix = prefix || this.keyPrefix;
    return `${finalPrefix}${key}`;
  }

  /**
   * Cache a value with optional TTL
   */
  public async set<T>(
    key: string,
    value: T,
    options: CacheOptions = {},
  ): Promise<boolean> {
    try {
      const cacheKey = this.generateKey(key, options.prefix);
      const ttl = options.ttl || this.defaultTTL;

      const cachedData: CachedData<T> = {
        data: value,
        timestamp: Date.now(),
      };

      const serialized = JSON.stringify(cachedData);
      return await redisService.set(cacheKey, serialized, ttl);
    } catch (error) {
      console.error(`Cache: Error setting key ${key}:`, error);
      return false;
    }
  }

  public async setIfAbsent<T>(
    key: string,
    value: T,
    options: CacheOptions = {},
  ): Promise<boolean> {
    try {
      const client = redisService.getClient();
      if (!client) {
        return false;
      }

      const cacheKey = this.generateKey(key, options.prefix);
      const ttl = options.ttl || this.defaultTTL;

      const cachedData: CachedData<T> = {
        data: value,
        timestamp: Date.now(),
      };

      const result = await client.set(cacheKey, JSON.stringify(cachedData), {
        NX: true,
        EX: ttl,
      });
      return result === "OK";
    } catch (error) {
      console.error(`Cache: Error setting key ${key} (NX):`, error);
      return false;
    }
  }

  /**
   * Get a cached value
   */
  public async get<T>(key: string, prefix?: string): Promise<T | null> {
    try {
      const cacheKey = this.generateKey(key, prefix);
      const cached = await redisService.get(cacheKey);

      if (!cached) {
        return null;
      }

      const cachedData: CachedData<T> = JSON.parse(cached);
      return cachedData.data;
    } catch (error) {
      console.error(`Cache: Error getting key ${key}:`, error);
      return null;
    }
  }

  /**
   * Get or set cache - fetch from cache or execute function and cache result
   */
  public async getOrSet<T>(
    key: string,
    fetchFunction: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    // Try to get from cache first
    const cached = await this.get<T>(key, options.prefix);
    if (cached !== null) {
      return cached;
    }

    // If not in cache, fetch the data
    const data = await fetchFunction();

    // Cache the result (non-blocking)
    this.set(key, data, options).catch((error) => {
      console.error(`Cache: Failed to cache key ${key}:`, error);
    });

    return data;
  }

  /**
   * Delete a cached value
   */
  public async delete(key: string, prefix?: string): Promise<boolean> {
    try {
      const cacheKey = this.generateKey(key, prefix);
      return await redisService.del(cacheKey);
    } catch (error) {
      console.error(`Cache: Error deleting key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete multiple keys matching a pattern
   */
  public async deletePattern(pattern: string): Promise<boolean> {
    try {
      const client = redisService.getClient();
      if (!client) {
        return false;
      }

      const fullPattern = this.generateKey(pattern);
      const keys = await client.keys(fullPattern);

      if (keys.length) {
        await client.del(keys);
      }

      return true;
    } catch (error) {
      console.error(`Cache: Error deleting pattern ${pattern}:`, error);
      return false;
    }
  }

  /**
   * Check if a key exists in cache
   */
  /**
   * Drop every key under an explicit prefix.
   *
   * `deletePattern` cannot do this: it runs the pattern through `generateKey`,
   * which prepends the default `crewcam:` prefix — so it can never match keys
   * written with a `prefix` option of their own, which is how the health
   * dashboard stores everything.
   *
   * Returns how many keys went, or null when Redis is unavailable, so a caller
   * can tell "nothing was cached" from "the cache could not be reached".
   */
  public async deleteByPrefix(prefix: string): Promise<number | null> {
    try {
      const client = redisService.getClient();
      if (!client) {
        return null;
      }

      const keys = await client.keys(`${prefix}*`);
      if (!keys.length) {
        return 0;
      }

      await client.del(keys);
      return keys.length;
    } catch (error) {
      console.error(`Cache: Error deleting prefix ${prefix}:`, error);
      return null;
    }
  }

  public async exists(key: string, prefix?: string): Promise<boolean> {
    try {
      const cacheKey = this.generateKey(key, prefix);
      return await redisService.exists(cacheKey);
    } catch (error) {
      console.error(`Cache: Error checking key ${key}:`, error);
      return false;
    }
  }

  /**
   * Set expiration time for a key
   */
  public async expire(
    key: string,
    seconds: number,
    prefix?: string,
  ): Promise<boolean> {
    try {
      const cacheKey = this.generateKey(key, prefix);
      return await redisService.expire(cacheKey, seconds);
    } catch (error) {
      console.error(`Cache: Error setting expiry for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Cache for user sessions
   */
  public async setUserSession(
    userId: string,
    sessionData: any,
    ttl: number = 86400, // 24 hours
  ): Promise<boolean> {
    return await this.set(`session:${userId}`, sessionData, {
      prefix: "user:",
      ttl,
    });
  }

  public async getUserSession(userId: string): Promise<any | null> {
    return await this.get(`session:${userId}`, "user:");
  }

  public async deleteUserSession(userId: string): Promise<boolean> {
    return await this.delete(`session:${userId}`, "user:");
  }

  /**
   * Cache for API responses
   */
  public async cacheApiResponse(
    endpoint: string,
    params: any,
    response: any,
    ttl: number = 300, // 5 minutes
  ): Promise<boolean> {
    const key = `api:${endpoint}:${JSON.stringify(params)}`;
    return await this.set(key, response, { ttl });
  }

  public async getCachedApiResponse(
    endpoint: string,
    params: any,
  ): Promise<any | null> {
    const key = `api:${endpoint}:${JSON.stringify(params)}`;
    return await this.get(key);
  }

  /**
   * Cache for database queries
   */
  public async cacheQuery(
    collection: string,
    query: any,
    result: any,
    ttl: number = 600, // 10 minutes
  ): Promise<boolean> {
    const key = `db:${collection}:${JSON.stringify(query)}`;
    return await this.set(key, result, { ttl });
  }

  public async getCachedQuery(
    collection: string,
    query: any,
  ): Promise<any | null> {
    const key = `db:${collection}:${JSON.stringify(query)}`;
    return await this.get(key);
  }

  /**
   * Invalidate cache for a specific collection
   */
  public async invalidateCollection(collection: string): Promise<boolean> {
    return await this.deletePattern(`db:${collection}:*`);
  }

  /**
   * Rate limiting helper
   */
  public async checkRateLimit(
    identifier: string,
    limit: number,
    windowSeconds: number = 60,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const key = `ratelimit:${identifier}`;
    const client = redisService.getClient();

    if (!client) {
      // If Redis is not available, allow the request
      return { allowed: true, remaining: limit };
    }

    try {
      const current = await client.incr(key);

      if (current === 1) {
        await client.expire(key, windowSeconds);
      }

      const remaining = Math.max(0, limit - current);
      return {
        allowed: current <= limit,
        remaining,
      };
    } catch (error) {
      console.error(
        `Cache: Error checking rate limit for ${identifier}:`,
        error,
      );
      // On error, allow the request
      return { allowed: true, remaining: limit };
    }
  }

  /**
   * Distributed lock implementation
   */
  public async acquireLock(
    lockKey: string,
    ttl: number = 30,
  ): Promise<boolean> {
    const key = `lock:${lockKey}`;
    const client = redisService.getClient();

    if (!client) {
      return true; // If Redis is not available, allow operation
    }

    try {
      const result = await client.set(key, "1", {
        NX: true, // Only set if not exists
        EX: ttl, // Expire after TTL seconds
      });
      return result === "OK";
    } catch (error) {
      console.error(`Cache: Error acquiring lock ${lockKey}:`, error);
      return false;
    }
  }

  public async releaseLock(lockKey: string): Promise<boolean> {
    const key = `lock:${lockKey}`;
    return await redisService.del(key);
  }

  /**
   * Batch operations
   */
  public async mset(
    items: Array<{ key: string; value: any; ttl?: number }>,
    prefix?: string,
  ): Promise<boolean> {
    const client = redisService.getClient();
    if (!client) {
      return false;
    }

    try {
      const multi = client.multi();

      for (const item of items) {
        const cacheKey = this.generateKey(item.key, prefix);
        const cachedData: CachedData<any> = {
          data: item.value,
          timestamp: Date.now(),
        };
        const serialized = JSON.stringify(cachedData);

        if (item.ttl) {
          multi.setEx(cacheKey, item.ttl, serialized);
        } else {
          multi.setEx(cacheKey, this.defaultTTL, serialized);
        }
      }

      await multi.exec();
      return true;
    } catch (error) {
      console.error("Cache: Error in batch set operation:", error);
      return false;
    }
  }

  public async mget<T>(
    keys: string[],
    prefix?: string,
  ): Promise<Array<T | null>> {
    const client = redisService.getClient();
    if (!client) {
      return keys.map(() => null);
    }

    try {
      const cacheKeys = keys.map((key) => this.generateKey(key, prefix));
      const results = await client.mGet(cacheKeys);

      return results.map((result) => {
        if (!result || typeof result !== "string") {
          return null;
        }
        try {
          const cachedData: CachedData<T> = JSON.parse(result);
          return cachedData.data;
        } catch {
          return null;
        }
      });
    } catch (error) {
      console.error("Cache: Error in batch get operation:", error);
      return keys.map(() => null);
    }
  }

  /**
   * Clear all cache (use with caution)
   */
  public async clearAll(): Promise<boolean> {
    return await redisService.flushDb();
  }

  /**
   * Get cache statistics
   */
  public async getStats(): Promise<any> {
    const client = redisService.getClient();
    if (!client) {
      return null;
    }

    try {
      const info = await client.info("memory");
      const dbSize = await client.dbSize();

      return {
        memoryInfo: info,
        totalKeys: dbSize,
        isConnected: redisService.isReady(),
      };
    } catch (error) {
      console.error("Cache: Error getting stats:", error);
      return null;
    }
  }
}

// Export singleton instance
export const cacheService = new CacheService();
