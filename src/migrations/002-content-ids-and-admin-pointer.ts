/**
 * Migration 002 (idempotent)
 *  1. posts / comments: ObjectId _id  ->  UUID string _id, rewriting every reference
 *     (comments.postId, comments.parentCommentId, reactions.postId). Comments get the denormalised pageId.
 *  2. pages: Page.accountId becomes the authoritative admin pointer; it is aligned with the existing admin
 *     membership row (older versions only updated the member rows on admin transfer).
 *
 * Run once against an existing database:  yarn migrate
 */
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import { env } from "../config/env";

const MIGRATION_ID = "002-content-ids-and-admin-pointer";

/* eslint-disable @typescript-eslint/no-explicit-any */
const run = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB database connection is not available");

  const migrations = db.collection("migrations");
  if (await migrations.findOne({ migrationId: MIGRATION_ID })) {
    console.log(`Migration ${MIGRATION_ID} already applied`);
    return;
  }

  const posts = db.collection<any>("posts");
  const comments = db.collection<any>("comments");
  const reactions = db.collection<any>("reactions");
  const pages = db.collection<any>("pages");
  const members = db.collection<any>("pagemembers");

  const postIdMap = new Map<string, string>();
  for (const post of await posts.find({}).toArray()) {
    if (typeof post._id === "string") continue;
    const newId = randomUUID();
    postIdMap.set(post._id.toString(), newId);
    await posts.insertOne({ ...post, _id: newId });
    await posts.deleteOne({ _id: post._id });
  }
  console.log(`Posts migrated: ${postIdMap.size}`);

  const commentIdMap = new Map<string, string>();
  for (const comment of await comments.find({}).toArray()) {
    if (typeof comment._id === "string") continue;
    commentIdMap.set(comment._id.toString(), randomUUID());
  }
  for (const comment of await comments.find({}).toArray()) {
    const newId = typeof comment._id === "string" ? comment._id : commentIdMap.get(comment._id.toString())!;
    const postId = postIdMap.get(String(comment.postId)) ?? String(comment.postId);
    const parent = comment.parentCommentId ? (commentIdMap.get(String(comment.parentCommentId)) ?? String(comment.parentCommentId)) : null;
    let pageId = comment.pageId;
    if (!pageId) pageId = (await posts.findOne({ _id: postId }))?.pageId;
    if (typeof comment._id === "string") {
      await comments.updateOne({ _id: comment._id }, { $set: { postId, parentCommentId: parent, ...(pageId ? { pageId } : {}) } });
    } else {
      await comments.insertOne({ ...comment, _id: newId, postId, parentCommentId: parent, ...(pageId ? { pageId } : {}) });
      await comments.deleteOne({ _id: comment._id });
    }
  }
  console.log(`Comments migrated: ${commentIdMap.size}`);

  for (const [oldId, newId] of postIdMap) await reactions.updateMany({ postId: oldId }, { $set: { postId: newId } });

  let aligned = 0;
  for (const page of await pages.find({}).toArray()) {
    const adminRow = await members.findOne({ pageId: String(page._id), role: "admin" });
    if (adminRow && adminRow.accountId !== page.accountId) {
      await pages.updateOne({ _id: page._id }, { $set: { accountId: adminRow.accountId } });
      aligned += 1;
    }
  }
  console.log(`Page admin pointers aligned: ${aligned}`);

  await migrations.insertOne({ migrationId: MIGRATION_ID, appliedAt: new Date() });
  console.log(`Migration ${MIGRATION_ID} applied`);
};

run()
  .catch((error) => {
    console.error(`Migration ${MIGRATION_ID} failed:`, error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
