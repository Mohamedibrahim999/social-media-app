import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

export type CleanupJobType = "account" | "page" | "post";
export type CleanupJobStatus = "pending" | "processing" | "completed" | "failed";

export interface ICleanupJob {
  _id: string;
  type: CleanupJobType;
  targetId: string;
  status: CleanupJobStatus;
  attempts: number;
  requestedBy: string | null;
  metadata: Record<string, unknown>;
  error: string | null;
  runAfter: Date;
  lockedUntil: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  expireAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const cleanupJobSchema = new Schema<ICleanupJob>(
  {
    _id: { type: String, default: () => randomUUID() },
    type: { type: String, enum: ["account", "page", "post"], required: true },
    targetId: { type: String, required: true },
    status: { type: String, enum: ["pending", "processing", "completed", "failed"], default: "pending", index: true },
    attempts: { type: Number, default: 0 },
    requestedBy: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    error: { type: String, default: null },
    runAfter: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    // Completed jobs are purged after a week (TTL index); failed jobs are kept for inspection.
    expireAt: { type: Date, default: null, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true, collection: "cleanup_jobs", minimize: false }
);

cleanupJobSchema.index({ status: 1, runAfter: 1, createdAt: 1 });

export const CleanupJobModel = model<ICleanupJob>("CleanupJob", cleanupJobSchema);
