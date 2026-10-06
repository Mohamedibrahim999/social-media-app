import { redisClient } from "../../config/redis";
import { env } from "../../config/env";

/**
 * Read-through cache on top of Redis.
 *
 *   read : Redis -> (miss) -> MongoDB -> SET key EX ttl
 *   write: MongoDB write -> DEL the affected keys
 *
 * Rules
 *  - Every key is prefixed with CACHE_EPOCH_PREFIX (bump the prefix to invalidate everything at once).
 *  - Every key has a TTL (default 300s) so a missed invalidation can only be stale for a bounded time.
 *  - Only non-sensitive, shared DTOs are cached. Never password hashes, tokens, OTPs or e-mail addresses.
 *  - A Redis outage degrades to "always miss" instead of failing requests.
 */

const STATS_NAMESPACE = "stats";
export const DEFAULT_TTL_SECONDS = 300;

export const buildKey = (key: string): string => `${env.CACHE_EPOCH_PREFIX}:${key}`;

const bump = (counter: "hits" | "misses"): void => {
  redisClient.incr(buildKey(`${STATS_NAMESPACE}:${counter}`)).catch(() => undefined);
};

export const getCache = async <T>(key: string): Promise<T | null> => {
  try {
    const value = await redisClient.get(buildKey(key));
    if (value === null) {
      bump("misses");
      return null;
    }
    bump("hits");
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const setCache = async <T>(key: string, value: T, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> => {
  try {
    await redisClient.set(buildKey(key), JSON.stringify(value), { EX: ttlSeconds });
  } catch (error) {
    console.error("Cache write failed:", (error as Error).message);
  }
};

export const deleteCache = async (...keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  try {
    await redisClient.del(keys.map(buildKey));
  } catch (error) {
    console.error("Cache invalidation failed:", (error as Error).message);
  }
};

export const deleteCacheByPattern = async (pattern: string): Promise<void> => {
  try {
    const batch: string[] = [];
    for await (const keys of redisClient.scanIterator({ MATCH: buildKey(pattern), COUNT: 200 })) {
      batch.push(...(Array.isArray(keys) ? keys : [keys]));
      if (batch.length >= 500) await redisClient.unlink(batch.splice(0, batch.length));
    }
    if (batch.length > 0) await redisClient.unlink(batch);
  } catch (error) {
    console.error("Cache pattern invalidation failed:", (error as Error).message);
  }
};

/** Cache-aside helper: returns the cached value or loads, stores and returns it. */
export const readThrough = async <T>(
  key: string,
  loader: () => Promise<T>,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<T> => {
  const cached = await getCache<T>(key);
  if (cached !== null) return cached;
  const fresh = await loader();
  await setCache(key, fresh, ttlSeconds);
  return fresh;
};

export const getCacheHealth = async () => {
  const hits = Number((await redisClient.get(buildKey(`${STATS_NAMESPACE}:hits`))) ?? 0);
  const misses = Number((await redisClient.get(buildKey(`${STATS_NAMESPACE}:misses`))) ?? 0);

  let keyCount = 0;
  const statsPrefix = buildKey(`${STATS_NAMESPACE}:`);
  for await (const keys of redisClient.scanIterator({ MATCH: buildKey("*"), COUNT: 500 })) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!key.startsWith(statsPrefix)) keyCount += 1;
    }
  }

  const info = await redisClient.info("stats");
  const evicted = Number(info.match(/evicted_keys:(\d+)/)?.[1] ?? 0);

  const total = hits + misses;
  return {
    hitRatio: total === 0 ? 0 : Number((hits / total).toFixed(4)),
    hits,
    misses,
    keyCount,
    evictionCount: evicted,
  };
};

// ---------------------------------------------------------------------------
// Versioned invalidation. A cached value whose key embeds the current versions
// of the things it depends on becomes unreachable the moment any version is
// bumped (O(1), no SCAN over thousands of per-user keys). Orphaned keys expire by TTL.
// ---------------------------------------------------------------------------
const VERSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const bumpVersion = async (name: string): Promise<void> => {
  try {
    const key = buildKey(`ver:${name}`);
    await redisClient.incr(key);
    await redisClient.expire(key, VERSION_TTL_SECONDS);
  } catch (error) {
    console.error("Cache version bump failed:", (error as Error).message);
  }
};

export const getVersions = async (names: string[]): Promise<string[]> => {
  if (names.length === 0) return [];
  try {
    const values = await redisClient.mGet(names.map((name) => buildKey(`ver:${name}`)));
    return values.map((value) => value ?? "0");
  } catch {
    // Unknown versions: return unique values so nothing stale can ever be served.
    return names.map(() => `x${Date.now()}${Math.random()}`);
  }
};
