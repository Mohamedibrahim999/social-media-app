import { z } from "zod";

// dotenv is skipped under Jest so a developer's local .env can never leak into (or be mutated by) test runs.
if (process.env.NODE_ENV !== "test") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    MONGO_URI: z.string().min(1),
    REDIS_URL: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_REFRESH_SECRET: z.string().min(16),
    CACHE_EPOCH_PREFIX: z.string().min(1),
    EMAIL_TRANSPORT: z.enum(["smtp", "file", "memory"]).default("smtp"),
    EMAIL_USER: z.string().optional().default(""),
    EMAIL_PASSWORD: z.string().optional().default(""),
  })
  .superRefine((value, ctx) => {
    if (value.EMAIL_TRANSPORT === "smtp" && (!value.EMAIL_USER || !value.EMAIL_PASSWORD)) {
      ctx.addIssue({
        code: "custom",
        message: "EMAIL_USER and EMAIL_PASSWORD are required when EMAIL_TRANSPORT=smtp",
        path: ["EMAIL_USER"],
      });
    }
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: "custom",
        message: "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ",
        path: ["JWT_REFRESH_SECRET"],
      });
    }
  });

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsedEnv.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsedEnv.data;
export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
export const isDevelopment = env.NODE_ENV === "development";
