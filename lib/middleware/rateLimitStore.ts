import {
  ClientRateLimitInfo,
  IncrementResponse,
  MemoryStore,
  Options,
  Store,
} from "express-rate-limit";
import { redisService } from "../services/redis/redisClient";

const KEY_PREFIX = "crewcam:ratelimit:";

/**
 * Rate-limit store backed by the shared Redis instance, so a budget holds
 * across every process rather than per-instance like the default MemoryStore.
 *
 * Degrades rather than fails: whenever Redis is unavailable or errors, calls
 * fall through to a per-process MemoryStore. That weakens the limit to
 * per-instance for the duration of the outage, which is the same protection the
 * app had before this store existed — never weaker, and never a 500.
 */
export class RedisRateLimitStore implements Store {
  // Keys live in Redis, so hits from different processes do share a counter.
  // express-rate-limit uses this to decide whether double-counting is a
  // misconfiguration; during a Redis outage we quietly do become local, but
  // reporting `false` is correct for the normal case.
  public localKeys = false;
  public prefix: string;

  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();

  constructor(namespace: string) {
    this.prefix = `${KEY_PREFIX}${namespace}:`;
  }

  public init = (options: Options): void => {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  };

  private buildKey = (key: string): string => `${this.prefix}${key}`;

  // isReady() is checked before getClient() because getClient logs a warning
  // on every miss, which would flood the logs at request volume.
  private getClient = () =>
    redisService.isReady() ? redisService.getClient() : null;

  public increment = async (key: string): Promise<IncrementResponse> => {
    const client = this.getClient();
    if (!client) return this.fallback.increment(key);

    try {
      const redisKey = this.buildKey(key);
      const totalHits = await client.incr(redisKey);
      let ttl = await client.pTTL(redisKey);

      // A fresh counter (or one that somehow lost its expiry) gets the window
      // applied. Re-applying is idempotent, so the race between two processes
      // both seeing a missing TTL is harmless.
      if (ttl < 0) {
        await client.pExpire(redisKey, this.windowMs);
        ttl = this.windowMs;
      }

      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    } catch (error) {
      console.error("RateLimit: Redis increment failed, using memory:", error);
      return this.fallback.increment(key);
    }
  };

  public decrement = async (key: string): Promise<void> => {
    const client = this.getClient();
    if (!client) return this.fallback.decrement(key);

    try {
      await client.decr(this.buildKey(key));
    } catch (error) {
      console.error("RateLimit: Redis decrement failed:", error);
    }
  };

  public resetKey = async (key: string): Promise<void> => {
    const client = this.getClient();
    if (!client) return this.fallback.resetKey(key);

    try {
      await client.del(this.buildKey(key));
    } catch (error) {
      console.error("RateLimit: Redis resetKey failed:", error);
    }
  };

  public get = async (
    key: string,
  ): Promise<ClientRateLimitInfo | undefined> => {
    const client = this.getClient();
    if (!client) return this.fallback.get(key);

    try {
      const redisKey = this.buildKey(key);
      const [raw, ttl] = await Promise.all([
        client.get(redisKey),
        client.pTTL(redisKey),
      ]);

      if (raw === null) return undefined;

      return {
        totalHits: Number(raw) || 0,
        resetTime: ttl >= 0 ? new Date(Date.now() + ttl) : undefined,
      };
    } catch (error) {
      console.error("RateLimit: Redis get failed:", error);
      return this.fallback.get(key);
    }
  };
}
