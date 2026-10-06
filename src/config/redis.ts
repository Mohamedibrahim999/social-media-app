import { createClient } from "redis";
import { env } from "./env";

/**
 * Single shared Redis connection used for cache, OTP hashes, rate limiting.
 * IMPORTANT: never issue blocking commands (BLPOP, BRPOP, ...) on this client –
 * they would block every other command queued behind them. Background jobs are
 * stored in MongoDB for that reason (see common/jobs).
 */
export const redisClient = createClient({ url: env.REDIS_URL });

redisClient.on("error", (error) => {
  console.error("Redis Client Error:", error.message);
});

export const connectRedis = async (): Promise<void> => {
  if (redisClient.isOpen) return;
  await redisClient.connect();
  console.log("Redis connected successfully");
};

export const disconnectRedis = async (): Promise<void> => {
  if (redisClient.isOpen) await redisClient.quit();
};

export const isRedisConnected = (): boolean => redisClient.isReady;
