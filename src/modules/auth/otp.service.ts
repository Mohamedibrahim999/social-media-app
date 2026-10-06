import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { redisClient } from "../../config/redis";
import { env } from "../../config/env";

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;

const otpKey = (accountId: string) => `auth:login:otp:${accountId}`;
const attemptsKey = (accountId: string) => `auth:login:otp:attempts:${accountId}`;

// Keyed HMAC (not a bare SHA-256): a 6-digit code has only 10^6 values, so an
// unkeyed hash read from Redis could be reversed instantly. Bound to the account id as well.
const hashOtp = (accountId: string, code: string): string =>
  createHmac("sha256", `${env.JWT_REFRESH_SECRET}|otp`).update(`${accountId}:${code}`).digest("hex");

const safeEqualHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Generates a CSPRNG 6-digit code. Only its keyed hash is stored; a new code replaces (invalidates) the old one. */
export const generateAndStoreOtp = async (accountId: string): Promise<string> => {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await redisClient.del(attemptsKey(accountId));
  await redisClient.set(otpKey(accountId), hashOtp(accountId, code), { EX: OTP_TTL_SECONDS });
  return code;
};

export const invalidateOtp = async (accountId: string): Promise<void> => {
  await redisClient.del([otpKey(accountId), attemptsKey(accountId)]);
};

export const verifyOtp = async (accountId: string, code: string): Promise<boolean> => {
  const stored = await redisClient.get(otpKey(accountId));
  if (!stored) return false;

  // Atomic attempt counter (INCR) – concurrent guesses cannot bypass the limit.
  const attempts = await redisClient.incr(attemptsKey(accountId));
  if (attempts === 1) await redisClient.expire(attemptsKey(accountId), OTP_TTL_SECONDS);
  if (attempts > OTP_MAX_ATTEMPTS) {
    await invalidateOtp(accountId);
    return false;
  }

  if (!safeEqualHex(stored, hashOtp(accountId, code))) {
    if (attempts >= OTP_MAX_ATTEMPTS) await invalidateOtp(accountId);
    return false;
  }

  // One-time use: DEL returns 1 for exactly one concurrent verifier.
  const removed = await redisClient.del(otpKey(accountId));
  await redisClient.del(attemptsKey(accountId));
  return removed === 1;
};
