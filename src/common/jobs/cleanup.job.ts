import { CleanupJobModel, CleanupJobType, ICleanupJob } from "./cleanup.model";

export const MAX_JOB_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000; // a worker that dies mid-job loses its lock after 5 minutes
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const createCleanupJob = async (input: {
  type: CleanupJobType;
  targetId: string;
  requestedBy?: string | null;
  metadata?: Record<string, unknown>;
}) =>
  CleanupJobModel.create({
    type: input.type,
    targetId: input.targetId,
    requestedBy: input.requestedBy ?? null,
    metadata: input.metadata ?? {},
  });

export const getCleanupJob = async (jobId: string) => CleanupJobModel.findById(jobId);

/**
 * Atomically claims the next runnable job (pending and due, or processing with an expired lock).
 * findOneAndUpdate is atomic, so several workers/processes can run side by side without double-processing.
 */
export const claimNextJob = async (): Promise<ICleanupJob | null> => {
  const now = new Date();
  return CleanupJobModel.findOneAndUpdate(
    {
      $or: [
        { status: "pending", runAfter: { $lte: now } },
        { status: "processing", lockedUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: "processing", lockedUntil: new Date(now.getTime() + LOCK_MS), startedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" }
  ).lean<ICleanupJob>();
};

export const markCompleted = async (jobId: string) =>
  CleanupJobModel.updateOne(
    { _id: jobId },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        lockedUntil: null,
        error: null,
        expireAt: new Date(Date.now() + COMPLETED_RETENTION_MS),
      },
    }
  );

export const markFailedOrRetry = async (job: ICleanupJob, message: string, retryDelayMs?: number) => {
  const exhausted = job.attempts >= MAX_JOB_ATTEMPTS;
  const delay = retryDelayMs ?? Math.min(60_000, 2_000 * 2 ** job.attempts);
  await CleanupJobModel.updateOne(
    { _id: job._id },
    exhausted
      ? { $set: { status: "failed", failedAt: new Date(), lockedUntil: null, error: message.slice(0, 500) } }
      : { $set: { status: "pending", runAfter: new Date(Date.now() + delay), lockedUntil: null, error: message.slice(0, 500) } }
  );
  return exhausted ? "failed" : "retry";
};
