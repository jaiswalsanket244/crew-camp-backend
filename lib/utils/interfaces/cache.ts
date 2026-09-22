/**
 * Cache-related interfaces and types
 */

export interface ICacheOptions {
  ttl?: number; // Time to live in seconds
  prefix?: string; // Key prefix for namespacing
}

export interface ICachedData<T> {
  data: T;
  timestamp: number;
  expiresAt?: number;
}

export interface ICacheStats {
  memoryInfo: string;
  totalKeys: number;
  isConnected: boolean;
}

export interface IRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt?: number;
}

export interface IBatchCacheItem {
  key: string;
  value: any;
  ttl?: number;
}

export interface IRedisConfig {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: boolean;
  connectionTimeout?: number;
  maxRetriesPerRequest?: number;
}

export interface ICacheService {
  // Basic operations
  set<T>(key: string, value: T, options?: ICacheOptions): Promise<boolean>;
  get<T>(key: string, prefix?: string): Promise<T | null>;
  delete(key: string, prefix?: string): Promise<boolean>;
  exists(key: string, prefix?: string): Promise<boolean>;
  expire(key: string, seconds: number, prefix?: string): Promise<boolean>;

  // Advanced operations
  getOrSet<T>(
    key: string,
    fetchFunction: () => Promise<T>,
    options?: ICacheOptions,
  ): Promise<T>;
  deletePattern(pattern: string): Promise<boolean>;

  // Batch operations
  mset(items: IBatchCacheItem[], prefix?: string): Promise<boolean>;
  mget<T>(keys: string[], prefix?: string): Promise<Array<T | null>>;

  // Specialized caching
  setUserSession(
    userId: string,
    sessionData: any,
    ttl?: number,
  ): Promise<boolean>;
  getUserSession(userId: string): Promise<any | null>;
  deleteUserSession(userId: string): Promise<boolean>;

  cacheApiResponse(
    endpoint: string,
    params: any,
    response: any,
    ttl?: number,
  ): Promise<boolean>;
  getCachedApiResponse(endpoint: string, params: any): Promise<any | null>;

  cacheQuery(
    collection: string,
    query: any,
    result: any,
    ttl?: number,
  ): Promise<boolean>;
  getCachedQuery(collection: string, query: any): Promise<any | null>;
  invalidateCollection(collection: string): Promise<boolean>;

  // Rate limiting
  checkRateLimit(
    identifier: string,
    limit: number,
    windowSeconds?: number,
  ): Promise<IRateLimitResult>;

  // Distributed locking
  acquireLock(lockKey: string, ttl?: number): Promise<boolean>;
  releaseLock(lockKey: string): Promise<boolean>;

  // Utilities
  clearAll(): Promise<boolean>;
  getStats(): Promise<ICacheStats | null>;
}

export enum CacheKeyPrefix {
  USER = "user:",
  SESSION = "session:",
  API = "api:",
  DB = "db:",
  RATE_LIMIT = "ratelimit:",
  LOCK = "lock:",
  PROJECT = "project:",
  POST = "post:",
  COMPANY = "company:",
  CREW = "crew:",
  NOTIFICATION = "notification:",
  FILE = "file:",
}

export enum CacheTTL {
  SHORT = 60, // 1 minute
  MEDIUM = 300, // 5 minutes
  DEFAULT = 600, // 10 minutes
  LONG = 3600, // 1 hour
  SESSION = 86400, // 24 hours
  WEEK = 604800, // 7 days
}

/**
 * Helper type for cache-aware function wrappers
 */
export type CacheableFunction<T> = () => Promise<T>;

/**
 * Cache invalidation strategies
 */
export enum CacheInvalidationStrategy {
  IMMEDIATE = "immediate", // Delete immediately
  LAZY = "lazy", // Mark as stale, refresh on next access
  SCHEDULED = "scheduled", // Schedule for deletion
  TTL = "ttl", // Let TTL handle expiration
}

/**
 * Cache event types for monitoring
 */
export enum CacheEvent {
  HIT = "cache_hit",
  MISS = "cache_miss",
  SET = "cache_set",
  DELETE = "cache_delete",
  ERROR = "cache_error",
  EXPIRED = "cache_expired",
}
