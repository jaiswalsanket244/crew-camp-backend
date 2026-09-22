/**
 * Redis Service Module
 *
 * This module exports all Redis-related functionality including:
 * - Redis client connection and operations
 * - High-level caching service
 * - Connection initialization function
 */

// Export the main Redis service and connection function
export { redisService, connectRedis } from "./redisClient";

// Export the cache service for high-level caching operations
export { cacheService } from "./cacheService";

// Re-export cache-related types and enums for convenience
export {
  ICacheOptions,
  ICachedData,
  ICacheStats,
  IRateLimitResult,
  IBatchCacheItem,
  IRedisConfig,
  ICacheService,
  CacheKeyPrefix,
  CacheTTL,
  CacheableFunction,
  CacheInvalidationStrategy,
  CacheEvent,
} from "../../utils/interfaces/cache";
