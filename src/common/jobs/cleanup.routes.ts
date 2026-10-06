import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.middleware";
import { AppError } from "../errors/AppError";
import { getCleanupJob } from "./cleanup.job";

const router = Router();

/** GET /internal/cleanup/:jobId – status of a cleanup job the caller requested (pending|processing|completed|failed). */
router.get("/:jobId", authMiddleware, async (req, res) => {
  const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params);
  const job = await getCleanupJob(jobId);
  // Other people's jobs look exactly like non-existent ones.
  if (!job || job.requestedBy !== req.user.accountId) throw new AppError("Cleanup job not found", 404, "JOB_NOT_FOUND");
  res.status(200).json({
    message: "Cleanup job fetched",
    data: {
      jobId: job._id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      failedAt: job.failedAt,
    },
  });
});

export default router;
