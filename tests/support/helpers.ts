import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import request from "supertest";
import app from "../../src/app";
import { connectDatabase, disconnectDatabase, ensureIndexes } from "../../src/config/database";
import { connectRedis, disconnectRedis, redisClient } from "../../src/config/redis";
import * as authService from "../../src/modules/auth/auth.service";
import { memoryOutbox } from "../../src/common/services/email.service";
import { runCleanupJobsOnce } from "../../src/common/workers/cleanup.worker";

export { app, request, redisClient, runCleanupJobsOnce, memoryOutbox };

export const api = () => request(app);

export const setupInfrastructure = async () => {
  await connectDatabase();
  await ensureIndexes();
  await connectRedis();
};

export const teardownInfrastructure = async () => {
  await disconnectDatabase();
  await disconnectRedis();
};

/** Empties every collection, the dedicated Redis DB, the mail outbox and the upload sandbox. */
export const resetState = async () => {
  const db = mongoose.connection.db!;
  for (const collection of await db.collections()) await collection.deleteMany({});
  await redisClient.flushDb();
  memoryOutbox.length = 0;
  for (const folder of ["profiles", "pages", "posts"]) {
    const directory = path.join(process.cwd(), "uploads", folder);
    if (fs.existsSync(directory)) for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
  }
};

export const resetRateLimits = async () => {
  for await (const keys of redisClient.scanIterator({ MATCH: "ratelimit:*", COUNT: 200 })) {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length) await redisClient.del(list);
  }
};

let counter = 0;
export const uniqueName = (prefix = "user") => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface TestUser {
  accountId: string;
  username: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  auth: { Authorization: string };
}

/** Creates a user through the real service layer (not mocked) – avoids tripping the HTTP rate limiters. */
export const createUser = async (prefix = "user"): Promise<TestUser> => {
  const username = uniqueName(prefix);
  const email = `${username}@example.test`;
  const password = "CorrectHorse9!";
  const registered = await authService.register({ username, email, password });
  const session = await authService.login({ identifier: username, password });
  if (session.requiresVerification) throw new Error("unexpected OTP flow");
  return {
    accountId: registered.externalId,
    username,
    email,
    password,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    auth: { Authorization: `Bearer ${session.accessToken}` },
  };
};

export const createPage = async (owner: TestUser, name = "Test Page") => {
  const response = await api().post("/page").set(owner.auth).send({ name, description: "desc" });
  expect(response.status).toBe(201);
  return response.body.data as { id: string; name: string; adminAccountId: string; picture: string };
};

export const createPost = async (author: TestUser, pageId: string, content = "hello world") => {
  const response = await api().post("/post").set(author.auth).field("pageId", pageId).field("content", content);
  expect(response.status).toBe(201);
  return response.body.data as { id: string; images: string[]; content: string };
};

export const subscribe = (user: TestUser, pageId: string) => api().post("/subscriptions").set(user.auth).send({ pageId });

// ---- tiny valid/invalid image fixtures --------------------------------------------------------------
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from("JFIF\0"), Buffer.alloc(32)]);
export const FAKE_IMAGE_BYTES = Buffer.from("<?php echo 'not an image'; ?> this is plain text pretending to be a picture");

export const uploadedFilesOnDisk = (folder: "profiles" | "pages" | "posts"): string[] => {
  const directory = path.join(process.cwd(), "uploads", folder);
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
};

export const drainCleanup = async () => {
  let total = 0;
  for (let round = 0; round < 5; round++) total += await runCleanupJobsOnce();
  return total;
};

/** `it` for tests that need MongoDB's single-document atomicity guarantee (skipped on non-atomic stand-ins). */
export const itAtomic: typeof it = (process.env.TAPI_ATOMIC_CAS === "0" ? it.skip : it) as typeof it;
