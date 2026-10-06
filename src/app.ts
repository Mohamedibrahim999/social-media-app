import express, { Request, Response } from "express";
import { env } from "./config/env";
import { isDatabaseConnected } from "./config/database";
import { isRedisConnected } from "./config/redis";
import { getCacheHealth } from "./common/cache/cache.service";
import { errorHandler, notFoundHandler } from "./common/middleware/error.middleware";
import { traceMiddleware } from "./common/middleware/trace.middleware";
import { createUploadsRouter } from "./common/middleware/upload.middleware";
import cleanupRoutes from "./common/jobs/cleanup.routes";
import authRoutes from "./modules/auth/auth.routes";
import profileRoutes from "./modules/profile/profile.routes";
import pageRoutes from "./modules/page/page.routes";
import postRoutes from "./modules/post/post.routes";
import subscriptionRoutes from "./modules/subscription/subscription.routes";
import feedRoutes from "./modules/feed/feed.routes";
import commentRoutes from "./modules/comment/comment.routes";
import reactionRoutes from "./modules/reaction/reaction.routes";

const app = express();

app.disable("x-powered-by");
// Number of reverse proxies in front of the API; makes req.ip (used by the rate limiters) trustworthy.
app.set("trust proxy", env.TRUST_PROXY);

// Trace header FIRST so even body-parser failures (malformed JSON) carry X-Tapi-Trace-Ref.
app.use(traceMiddleware);
app.use(express.json({ limit: "100kb" }));

app.use("/uploads", createUploadsRouter()); // public, no authentication

app.use("/auth", authRoutes);
app.use("/profile", profileRoutes);
app.use("/page", pageRoutes);
app.use("/post", postRoutes);
app.use("/subscriptions", subscriptionRoutes);
app.use("/feed", feedRoutes);
app.use("/comments", commentRoutes);
app.use("/reactions", reactionRoutes);
app.use("/internal/cleanup", cleanupRoutes);

app.get("/health", async (_req: Request, res: Response) => {
  const database = isDatabaseConnected();
  const redis = isRedisConnected();
  const cache = redis ? await getCacheHealth().catch(() => null) : null;
  res.status(database && redis ? 200 : 503).json({
    status: database && redis ? "ok" : "degraded",
    services: { database, redis },
    cache,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
