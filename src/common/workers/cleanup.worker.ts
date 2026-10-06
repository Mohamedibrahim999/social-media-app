import { claimNextJob, markCompleted, markFailedOrRetry } from "../jobs/cleanup.job";
import { PreconditionNotMetError, cleanupHandlers } from "../jobs/cleanup.handlers";

const POLL_INTERVAL_MS = 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** Processes every currently runnable job. Also used directly by tests to drain the queue deterministically. */
export const runCleanupJobsOnce = async (): Promise<number> => {
  if (running) return 0;
  running = true;
  let processed = 0;
  try {
    for (;;) {
      const job = await claimNextJob();
      if (!job) break;
      processed += 1;
      try {
        const handler = cleanupHandlers[job.type];
        if (!handler) throw new Error(`No cleanup handler registered for type "${job.type}"`);
        await handler(job);
        await markCompleted(job._id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryIn = error instanceof PreconditionNotMetError ? 3000 : undefined;
        const outcome = await markFailedOrRetry(job, message, retryIn);
        console.error(`Cleanup job ${job._id} (${job.type}) ${outcome === "failed" ? "FAILED" : "will retry"}: ${message}`);
      }
    }
  } finally {
    running = false;
  }
  return processed;
};

/** Jobs live in MongoDB (durable, status-tracked) and are polled; Redis is never blocked. */
export const startCleanupWorker = (): void => {
  if (timer) return;
  timer = setInterval(() => {
    runCleanupJobsOnce().catch((error) => console.error("Cleanup worker error:", (error as Error).message));
  }, POLL_INTERVAL_MS);
  timer.unref();
  console.log("Cleanup worker started");
};

export const stopCleanupWorker = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
