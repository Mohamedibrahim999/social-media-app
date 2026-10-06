import app from "./app";
import { env } from "./config/env";
import { connectDatabase, disconnectDatabase, ensureIndexes } from "./config/database";
import { connectRedis, disconnectRedis } from "./config/redis";
import { startCleanupWorker, stopCleanupWorker } from "./common/workers/cleanup.worker";

const startServer = async (): Promise<void> => {
  await connectDatabase();
  await ensureIndexes(); // unique / partial-unique constraints must exist before serving traffic
  await connectRedis();
  startCleanupWorker();

  const server = app.listen(env.PORT, () => {
    console.log(`Tapi API running on port ${env.PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    stopCleanupWorker();
    server.close(async () => {
      await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

startServer().catch((error) => {
  console.error("Failed to start server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
