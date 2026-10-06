import {
  PNG_BYTES, api, createPage, createPost, createUser, drainCleanup, resetState, setupInfrastructure, subscribe,
  teardownInfrastructure, uploadedFilesOnDisk, redisClient, TestUser,
} from "./support/helpers";
import { CleanupJobModel } from "../src/common/jobs/cleanup.model";
import { createCleanupJob, MAX_JOB_ATTEMPTS } from "../src/common/jobs/cleanup.job";
import { runCleanupJobsOnce } from "../src/common/workers/cleanup.worker";
import { AccountModel } from "../src/modules/auth/auth.model";
import { CommentModel } from "../src/modules/comment/comment.model";
import { PageMemberModel } from "../src/modules/page/page-member.model";
import { PageModel } from "../src/modules/page/page.model";
import { PostModel } from "../src/modules/post/post.model";
import { ProfileModel } from "../src/modules/profile/profile.model";
import { ReactionModel } from "../src/modules/reaction/reaction.model";
import { SubscriptionModel } from "../src/modules/subscription/subscription.model";
import { TokenAncestryModel } from "../src/modules/auth/token-ancestry.model";

beforeAll(setupInfrastructure);
afterAll(teardownInfrastructure);
beforeEach(resetState);

const addEditor = (admin: TestUser, pageId: string, username: string) =>
  api().post(`/page/${pageId}/members/editors`).set(admin.auth).send({ username });

/** page + editor + 2 subscribers, posts with images, comments, replies, reactions */
const populate = async () => {
  const admin = await createUser("adm");
  const editor = await createUser("ed");
  const fan1 = await createUser("fan1");
  const fan2 = await createUser("fan2");
  const page = await createPage(admin);
  await addEditor(admin, page.id, editor.username);
  await api().post(`/page/${page.id}/picture`).set(admin.auth).attach("image", PNG_BYTES, { filename: "p.png", contentType: "image/png" });
  await subscribe(fan1, page.id);
  await subscribe(fan2, page.id);
  const posts: string[] = [];
  for (const [i, author] of [admin, editor].entries()) {
    const res = await api().post("/post").set(author.auth).field("pageId", page.id).field("content", `post ${i}`).attach("images", PNG_BYTES, { filename: "i.png", contentType: "image/png" });
    posts.push(res.body.data.id);
  }
  for (const postId of posts) {
    const top = await api().post(`/comments/post/${postId}`).set(fan1.auth).send({ content: "top" });
    await api().post(`/comments/post/${postId}`).set(fan2.auth).send({ content: "reply", parentCommentId: top.body.data.id });
    await api().post(`/reactions/post/${postId}`).set(fan1.auth).send({ type: "like" });
    await api().post(`/reactions/post/${postId}`).set(fan2.auth).send({ type: "wow" });
  }
  await api().get("/feed").set(fan1.auth); // fill caches
  await api().get(`/post/page/${page.id}`).set(fan1.auth);
  return { admin, editor, fan1, fan2, page, posts };
};

const redisKeysMatching = async (needle: string) => {
  const found: string[] = [];
  for await (const keys of redisClient.scanIterator({ MATCH: `*${needle}*`, COUNT: 200 })) found.push(...(Array.isArray(keys) ? keys : [keys]));
  return found;
};

describe("post deletion cleanup", () => {
  it("removes comments, replies, reactions, images, cache entries and feed references", async () => {
    const { admin, fan1, page, posts } = await populate();
    expect(uploadedFilesOnDisk("posts")).toHaveLength(2);
    const res = await api().delete(`/post/${posts[0]}`).set(admin.auth);
    expect(res.status).toBe(202);
    const jobId = res.body.data.cleanupJobId;
    expect(["pending", "processing", "completed"]).toContain((await api().get(`/internal/cleanup/${jobId}`).set(admin.auth)).body.data.status);

    await drainCleanup();
    expect((await api().get(`/internal/cleanup/${jobId}`).set(admin.auth)).body.data.status).toBe("completed");
    expect(await CommentModel.countDocuments({ postId: posts[0] })).toBe(0); // comments AND replies
    expect(await ReactionModel.countDocuments({ postId: posts[0] })).toBe(0);
    expect(uploadedFilesOnDisk("posts")).toHaveLength(1); // only the other post's image remains
    expect(await redisKeysMatching(posts[0])).toEqual([]);
    expect((await api().get("/feed").set(fan1.auth)).body.data.items.map((p: { id: string }) => p.id)).toEqual([posts[1]]);
    // the sibling post is untouched
    expect(await CommentModel.countDocuments({ postId: posts[1] })).toBe(2);
    expect(await ReactionModel.countDocuments({ postId: posts[1] })).toBe(2);
    expect(await PostModel.countDocuments({ pageId: page.id })).toBe(1);
  });
});

describe("page deletion cleanup", () => {
  it("removes memberships, subscriptions, posts, comments, reactions, images, picture and cache", async () => {
    const { admin, fan1, page } = await populate();
    expect(uploadedFilesOnDisk("pages")).toHaveLength(1);
    const res = await api().delete(`/page/${page.id}`).set(admin.auth);
    expect(res.status).toBe(202);
    await drainCleanup();

    expect(await PageModel.countDocuments({ _id: page.id })).toBe(0);
    expect(await PageMemberModel.countDocuments({ pageId: page.id })).toBe(0);
    expect(await SubscriptionModel.countDocuments({ pageId: page.id })).toBe(0);
    expect(await PostModel.countDocuments({ pageId: page.id })).toBe(0);
    expect(await CommentModel.countDocuments({ pageId: page.id })).toBe(0);
    expect(await ReactionModel.countDocuments({})).toBe(0);
    expect(uploadedFilesOnDisk("posts")).toHaveLength(0);
    expect(uploadedFilesOnDisk("pages")).toHaveLength(0);
    expect(await redisKeysMatching(page.id)).toEqual(expect.not.arrayContaining([expect.stringContaining(":page:id:")]));
    expect((await api().get("/feed").set(fan1.auth)).body.data.items).toEqual([]);
    expect((await api().get(`/internal/cleanup/${res.body.data.cleanupJobId}`).set(admin.auth)).body.data.status).toBe("completed");
  });
});

describe("account deletion cleanup", () => {
  it("revokes sessions at once and removes all of the account's data in the background", async () => {
    const { admin, editor, fan1, page, posts } = await populate();
    await api().post("/profile/picture").set(admin.auth).attach("image", PNG_BYTES, { filename: "p.png", contentType: "image/png" });
    const otherPage = await createPage(editor, "Editor's own page");
    await createPost(editor, otherPage.id, "on my page");

    // delete the editor: authored post on someone else's page, own page, comments, reactions, subscriptions
    await api().post(`/comments/post/${posts[0]}`).set(editor.auth).send({ content: "from the editor" });
    await api().post(`/reactions/post/${posts[0]}`).set(editor.auth).send({ type: "haha" });
    await subscribe(editor, page.id);
    const res = await api().delete("/auth/account").set(editor.auth);
    expect(res.status).toBe(202);
    expect((await api().get("/profile/me").set(editor.auth)).status).toBe(401); // immediately unusable
    expect((await api().post("/auth/refresh").send({ refreshToken: editor.refreshToken })).status).toBe(401);
    expect((await api().post("/auth/login").send({ identifier: editor.username, password: editor.password })).status).toBe(401);

    await drainCleanup();
    expect(await AccountModel.countDocuments({ externalId: editor.accountId })).toBe(0);
    expect(await ProfileModel.countDocuments({ accountId: editor.accountId })).toBe(0);
    expect(await PageMemberModel.countDocuments({ accountId: editor.accountId })).toBe(0);
    expect(await SubscriptionModel.countDocuments({ accountId: editor.accountId })).toBe(0);
    expect(await ReactionModel.countDocuments({ accountId: editor.accountId })).toBe(0);
    expect(await CommentModel.countDocuments({ accountId: editor.accountId })).toBe(0);
    expect(await PostModel.countDocuments({ accountId: editor.accountId })).toBe(0);
    expect(await PageModel.countDocuments({ _id: otherPage.id })).toBe(0); // pages it administered are gone with their content
    expect(await TokenAncestryModel.countDocuments({ accountId: editor.accountId })).toBe(0);
    // the editor's post on the shared page took its image, comments and reactions with it
    expect(await CommentModel.countDocuments({ postId: posts[1] })).toBe(0);
    expect(await ReactionModel.countDocuments({ postId: posts[1] })).toBe(0);
    // unrelated data survives
    expect(await PageModel.countDocuments({ _id: page.id })).toBe(1);
    expect(await PostModel.countDocuments({ _id: posts[0] })).toBe(1);
    expect((await api().get("/feed").set(fan1.auth)).body.data.items.map((p: { id: string }) => p.id)).toEqual([posts[0]]);
    expect(await CleanupJobModel.countDocuments({ type: "account", status: "completed" })).toBe(1);
  });

  it("deletes a page admin's pages and every uploaded file", async () => {
    const { admin, page } = await populate();
    await api().post("/profile/picture").set(admin.auth).attach("image", PNG_BYTES, { filename: "p.png", contentType: "image/png" });
    await api().delete("/auth/account").set(admin.auth);
    await drainCleanup();
    expect(await PageModel.countDocuments({ _id: page.id })).toBe(0);
    expect(await PostModel.countDocuments({})).toBe(0);
    for (const folder of ["profiles", "pages", "posts"] as const) expect(uploadedFilesOnDisk(folder)).toEqual([]);
  });
});

describe("job system", () => {
  it("every job type has a wired handler (no 'not implemented' paths) and jobs expose their status", async () => {
    for (const type of ["post", "page", "account"] as const) {
      const job = await createCleanupJob({ type, targetId: crypto.randomUUID(), metadata: {} });
      expect(job.status).toBe("pending");
    }
    expect(await runCleanupJobsOnce()).toBe(3);
    const jobs = await CleanupJobModel.find();
    expect(jobs.map((j) => j.status)).toEqual(["completed", "completed", "completed"]);
    expect(jobs.every((j) => j.attempts === 1 && j.completedAt && j.startedAt)).toBe(true);
  });

  it("a job whose target still exists does not destroy data: it is retried, then marked failed", async () => {
    const { admin, page, posts } = await populate();
    const job = await createCleanupJob({ type: "post", targetId: posts[0], requestedBy: admin.accountId, metadata: { pageId: page.id, images: [] } });
    await runCleanupJobsOnce();
    expect(await CommentModel.countDocuments({ postId: posts[0] })).toBe(2); // untouched
    expect((await CleanupJobModel.findById(job._id))!.status).toBe("pending");
    for (let i = 1; i < MAX_JOB_ATTEMPTS; i++) {
      await CleanupJobModel.updateOne({ _id: job._id }, { $set: { runAfter: new Date(0) } });
      await runCleanupJobsOnce();
    }
    const failed = await CleanupJobModel.findById(job._id);
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toMatch(/still exists/);
    expect(failed!.failedAt).toBeTruthy();
    expect(await CommentModel.countDocuments({ postId: posts[0] })).toBe(2);
  });

  it("recovers a job abandoned in 'processing' by a crashed worker", async () => {
    const job = await createCleanupJob({ type: "post", targetId: crypto.randomUUID(), metadata: {} });
    await CleanupJobModel.updateOne({ _id: job._id }, { $set: { status: "processing", lockedUntil: new Date(Date.now() - 1000), attempts: 1 } });
    expect(await runCleanupJobsOnce()).toBe(1);
    expect((await CleanupJobModel.findById(job._id))!.status).toBe("completed");
  });

  it("job status is visible only to the requester and needs authentication", async () => {
    const { admin, fan1, posts } = await populate();
    const res = await api().delete(`/post/${posts[0]}`).set(admin.auth);
    const jobId = res.body.data.cleanupJobId;
    expect((await api().get(`/internal/cleanup/${jobId}`)).status).toBe(401);
    expect((await api().get(`/internal/cleanup/${jobId}`).set(fan1.auth)).status).toBe(404);
    expect((await api().get("/internal/cleanup/not-a-uuid").set(admin.auth)).status).toBe(400);
    const body = (await api().get(`/internal/cleanup/${jobId}`).set(admin.auth)).body.data;
    expect(Object.keys(body).sort()).toEqual(["attempts", "completedAt", "createdAt", "error", "failedAt", "jobId", "startedAt", "status", "type"]);
  });
});
