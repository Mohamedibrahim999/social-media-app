import { createHash } from "crypto";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { redisClient } from "../../config/redis";
import { AppError } from "../errors/AppError";

interface RateLimitOptions {
  windowSeconds: number;
  /** Ceiling per client IP (generous: many users can share one NAT address). */
  maxPerIp: number;
  keyPrefix: string;
  message: string;
  /** Optional second dimension (e.g. the login identifier) with its own, stricter ceiling. */
  subject?: { value: (req: Request) => string | undefined; max: number };
}

// Atomic INCR + EXPIRE: a crash between the two calls can never leave a counter without a TTL.
const INCR_WITH_TTL = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('TTL', KEYS[1])}
`;

const hit = async (key: string, windowSeconds: number): Promise<{ count: number; ttl: number }> => {
  const [count, ttl] = (await redisClient.eval(INCR_WITH_TTL, {
    keys: [key],
    arguments: [String(windowSeconds)],
  })) as [number, number];
  return { count, ttl };
};

/**
 * Client IP comes from req.ip, which honours the TRUST_PROXY setting.
 * X-Forwarded-For is NOT read directly – a client could rotate it to dodge the limit.
 */
export const createRateLimiter = (options: RateLimitOptions): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const checks = [{ key: `ratelimit:${options.keyPrefix}:ip:${req.ip ?? "unknown"}`, max: options.maxPerIp }];
      const subject = options.subject?.value(req);
      if (subject) {
        checks.push({
          key: `ratelimit:${options.keyPrefix}:sub:${createHash("sha256").update(subject).digest("hex")}`,
          max: options.subject!.max,
        });
      }

      let exceeded = false;
      let tightest = { remaining: Number.MAX_SAFE_INTEGER, limit: 0, ttl: 0 };
      for (const check of checks) {
        const { count, ttl } = await hit(check.key, options.windowSeconds);
        if (count > check.max) exceeded = true;
        const remaining = Math.max(0, check.max - count);
        if (remaining < tightest.remaining) tightest = { remaining, limit: check.max, ttl: Math.max(0, ttl) };
      }

      res.setHeader("X-RateLimit-Limit", tightest.limit);
      res.setHeader("X-RateLimit-Remaining", tightest.remaining);
      res.setHeader("X-RateLimit-Reset", tightest.ttl);

      if (exceeded) {
        res.setHeader("Retry-After", Math.max(1, tightest.ttl));
        throw new AppError(options.message, 429, "RATE_LIMIT_EXCEEDED");
      }
      next();
    } catch (error) {
      if (error instanceof AppError) return next(error);
      // Redis outage: fail open (availability of login) but make it visible in the logs.
      console.error(`[${req.traceRef}] rate limiter unavailable:`, (error as Error).message);
      next();
    }
  };
};

const bodyString = (req: Request, field: string): string | undefined => {
  const value = (req.body as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
};

export const registerRateLimiter = createRateLimiter({
  windowSeconds: 15 * 60,
  maxPerIp: 10,
  keyPrefix: "register",
  message: "Too many registration attempts. Please try again later.",
});

// Brute-force protection is per ACCOUNT (identifier); the per-IP ceiling only stops one address from spraying many accounts.
export const loginRateLimiter = createRateLimiter({
  windowSeconds: 15 * 60,
  maxPerIp: 100,
  keyPrefix: "login",
  message: "Too many login attempts. Please try again later.",
  subject: { value: (req) => bodyString(req, "identifier"), max: 10 },
});

export const loginVerifyRateLimiter = createRateLimiter({
  windowSeconds: 15 * 60,
  maxPerIp: 60,
  keyPrefix: "login-verify",
  message: "Too many verification attempts. Please try again later.",
  subject: { value: (req) => bodyString(req, "externalId"), max: 10 },
});

export const refreshRateLimiter = createRateLimiter({
  windowSeconds: 15 * 60,
  maxPerIp: 60,
  keyPrefix: "refresh",
  message: "Too many refresh attempts. Please try again later.",
});
