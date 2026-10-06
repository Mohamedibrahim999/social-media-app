import mongoose from "mongoose";
import { env } from "./env";

export const connectDatabase = async (): Promise<void> => {
  // Never log env.MONGO_URI: it may contain credentials.
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  console.log("MongoDB connected successfully");
};

export const disconnectDatabase = async (): Promise<void> => {
  await mongoose.disconnect();
};

export const isDatabaseConnected = (): boolean => mongoose.connection.readyState === 1;

/** Builds every schema index (unique username/email/membership/subscription/reaction, one-admin-per-page, TTLs). */
export const ensureIndexes = async (): Promise<void> => {
  for (const model of Object.values(mongoose.models)) {
    try {
      await model.init();
    } catch (error) {
      // Some MongoDB-compatible servers (e.g. FerretDB) do not implement partial indexes. The one-admin
      // invariant is still guaranteed by the single Page.accountId pointer; only the extra DB-level
      // safety net is missing, so warn loudly instead of refusing to start.
      if ((error as { code?: number }).code === 238) {
        console.warn(`WARNING: ${model.modelName}: an index option is not supported by this server (${(error as Error).message})`);
        continue;
      }
      console.error(`Index build failed for ${model.modelName}:`, (error as Error).message);
      throw error;
    }
  }
};
