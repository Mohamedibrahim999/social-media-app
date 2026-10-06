import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { createHash } from "crypto";
import { env } from "./config/env";
import { ensureIndexes } from "./config/database";
import { AccountModel } from "./modules/auth/auth.model";
import { ProfileModel } from "./modules/profile/profile.model";
import { PageModel } from "./modules/page/page.model";
import { PageMemberModel } from "./modules/page/page-member.model";
import { SubscriptionModel } from "./modules/subscription/subscription.model";
import { PostModel } from "./modules/post/post.model";
import { CommentModel } from "./modules/comment/comment.model";
import { ReactionModel, REACTION_TYPES } from "./modules/reaction/reaction.model";

const SEED_USERNAME = "seed_operator";
const SEED_EMAIL = "seed_operator@tapi.local";
const SEED_PASSWORD = "SeedOperator123!";
const SEED_PAGE_ID = "768c4266-ad8d-49f6-845b-5f14a15630f2";
const OTHER_PASSWORD = "SeedUser123!";

type AnyBulkOp = { updateOne: { filter: Record<string, unknown>; update: Record<string, unknown>; upsert: boolean } };

const EDITOR_COUNT = 3;
const SUBSCRIBER_COUNT = 55; // > MAX_PAGE_SIZE (50) so "next page" exists even at the maximum size
const POST_COUNT = 60;
const COMMENTS_ON_FIRST_POST = 55;
const REPLIES_ON_FIRST_COMMENT = 5;

/** Deterministic UUID-shaped id => re-running the seed updates instead of duplicating. */
const stableId = (name: string): string => {
  const hex = createHash("sha1").update(`tapi-seed:${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Small batches keep every bulk write fast and well-behaved on any MongoDB-compatible server. */
const inChunks = async <T>(items: T[], write: (chunk: T[]) => Promise<unknown>, size = 25): Promise<void> => {
  for (let i = 0; i < items.length; i += size) await write(items.slice(i, i + size));
};

const run = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI);
  await ensureIndexes();
  console.log("===== Tapi Seed Started =====");

  const operatorHash = await bcrypt.hash(SEED_PASSWORD, 12);
  const otherHash = await bcrypt.hash(OTHER_PASSWORD, 12); // one hash reused for all demo users (speed)

  const ensureUser = async (username: string, email: string, passwordHash: string, displayName: string) => {
    const existing = await AccountModel.findOne({ username });
    const externalId = existing?.externalId ?? stableId(`account:${username}`);
    await AccountModel.updateOne(
      { externalId },
      { $set: { username, email, passwordHash }, $setOnInsert: { externalId } },
      { upsert: true }
    );
    await ProfileModel.updateOne(
      { accountId: externalId },
      { $setOnInsert: { accountId: externalId, displayName, bio: "", picture: null } },
      { upsert: true }
    );
    return externalId;
  };

  console.log("Users…");
  const operatorId = await ensureUser(SEED_USERNAME, SEED_EMAIL, operatorHash, "Seed Operator");

  const editorIds: string[] = [];
  for (let i = 1; i <= EDITOR_COUNT; i++) {
    editorIds.push(await ensureUser(`seed_editor_${i}`, `seed_editor_${i}@tapi.local`, otherHash, `Seed Editor ${i}`));
  }
  const subscriberIds: string[] = [];
  for (let i = 1; i <= SUBSCRIBER_COUNT; i++) {
    subscriberIds.push(
      await ensureUser(`seed_subscriber_${i}`, `seed_subscriber_${i}@tapi.local`, otherHash, `Seed Subscriber ${i}`)
    );
  }

  console.log("Page, members, subscriptions…");
  // Page: Page.accountId is the single admin pointer; membership rows are aligned with it.
  await PageModel.updateOne(
    { _id: SEED_PAGE_ID },
    {
      $set: { accountId: operatorId, name: "Tapi Seed Page", description: "Seed page for pagination and feature testing." },
      $setOnInsert: { picture: null },
    },
    { upsert: true }
  );
  await PageMemberModel.updateMany({ pageId: SEED_PAGE_ID, role: "admin", accountId: { $ne: operatorId } }, { $set: { role: "editor" } });
  await PageMemberModel.updateOne({ pageId: SEED_PAGE_ID, accountId: operatorId }, { $set: { role: "admin" } }, { upsert: true });
  for (const editorId of editorIds) {
    await PageMemberModel.updateOne({ pageId: SEED_PAGE_ID, accountId: editorId }, { $setOnInsert: { role: "editor" } }, { upsert: true });
  }
  await inChunks(
    [operatorId, ...subscriberIds].map((accountId) => ({
      updateOne: { filter: { accountId, pageId: SEED_PAGE_ID }, update: { $setOnInsert: { accountId, pageId: SEED_PAGE_ID } }, upsert: true },
    })),
    (chunk) => SubscriptionModel.bulkWrite(chunk)
  );

  console.log("Posts…");
  // Posts: one per minute; every 10th pair shares an identical createdAt to exercise tie-break ordering.
  const authors = [operatorId, ...editorIds];
  const base = Date.now() - POST_COUNT * 60_000;
  const postIds: string[] = [];
  const postOps: AnyBulkOp[] = [];
  for (let i = 1; i <= POST_COUNT; i++) {
    const id = stableId(`post:${i}`);
    postIds.push(id);
    const slot = i % 10 === 0 ? i - 1 : i; // posts 10,20,... share the previous post's timestamp
    const createdAt = new Date(base + slot * 60_000);
    postOps.push({
      updateOne: {
        filter: { _id: id },
        update: {
          $set: { pageId: SEED_PAGE_ID, accountId: authors[i % authors.length], content: `Seed post #${i} – pagination test content.`, images: [], createdAt, updatedAt: createdAt },
        },
        upsert: true,
      },
    });
  }
  await inChunks(postOps, (chunk) => PostModel.collection.bulkWrite(chunk as never));

  console.log("Comments…");
  // Comments: first post gets 55 top-level comments (+ replies on the first); others get 2.
  const commentOps: AnyBulkOp[] = [];
  const addComment = (id: string, postId: string, accountId: string, content: string, parent: string | null, order: number) => {
    const createdAt = new Date(base + order * 1000);
    commentOps.push({
      updateOne: { filter: { _id: id }, update: { $set: { postId, pageId: SEED_PAGE_ID, accountId, content, parentCommentId: parent, createdAt, updatedAt: createdAt } }, upsert: true },
    });
  };
  const firstPost = postIds[0];
  for (let c = 1; c <= COMMENTS_ON_FIRST_POST; c++) {
    addComment(stableId(`comment:1:${c}`), firstPost, subscriberIds[c % subscriberIds.length], `Seed comment #${c} on post 1`, null, c);
  }
  for (let r = 1; r <= REPLIES_ON_FIRST_COMMENT; r++) {
    addComment(stableId(`reply:1:1:${r}`), firstPost, subscriberIds[(r + 7) % subscriberIds.length], `Seed reply #${r}`, stableId("comment:1:1"), 100 + r);
  }
  for (let p = 1; p < postIds.length; p++) {
    for (let c = 1; c <= 2; c++) {
      addComment(stableId(`comment:${p + 1}:${c}`), postIds[p], subscriberIds[(p + c) % subscriberIds.length], `Seed comment #${c} on post ${p + 1}`, null, c);
    }
  }
  await inChunks(commentOps, (chunk) => CommentModel.collection.bulkWrite(chunk as never));

  console.log("Reactions…");
  // Reactions: first post is reacted to by every subscriber (all six types); others by a rotating subset.
  const reactionOps: AnyBulkOp[] = [];
  subscriberIds.forEach((accountId, index) => {
    reactionOps.push({
      updateOne: { filter: { postId: firstPost, accountId }, update: { $set: { type: REACTION_TYPES[index % REACTION_TYPES.length] } }, upsert: true },
    });
  });
  postIds.slice(1).forEach((postId, p) => {
    for (let k = 0; k < 5; k++) {
      const accountId = subscriberIds[(p + k) % subscriberIds.length];
      reactionOps.push({ updateOne: { filter: { postId, accountId }, update: { $set: { type: REACTION_TYPES[(p + k) % 6] } }, upsert: true } });
    }
  });
  await inChunks(reactionOps, (chunk) => ReactionModel.bulkWrite(chunk as never));

  console.log(`Operator : ${SEED_USERNAME} / ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  console.log(`Page     : ${SEED_PAGE_ID}`);
  console.log(`Members  : 1 admin + ${EDITOR_COUNT} editors (password ${OTHER_PASSWORD})`);
  console.log(`Subscribers: ${SUBSCRIBER_COUNT + 1} | Posts: ${POST_COUNT} | Comments on post 1: ${COMMENTS_ON_FIRST_POST} (+${REPLIES_ON_FIRST_COMMENT} replies)`);
  console.log("===== Tapi Seed Finished =====");
};

run()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
