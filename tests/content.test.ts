import {
  PNG_BYTES, api, createPage, createPost, createUser, drainCleanup, itAtomic, resetState, setupInfrastructure,
  subscribe, teardownInfrastructure, uploadedFilesOnDisk, TestUser,
} from "./support/helpers";
import { CommentModel } from "../src/modules/comment/comment.model";
import { ReactionModel } from "../src/modules/reaction/reaction.model";

beforeAll(setupInfrastructure);
afterAll(teardownInfrastructure);
beforeEach(resetState);

const addEditor = (admin: TestUser, pageId: string, username: string) =>
  api().post(`/page/${pageId}/members/editors`).set(admin.auth).send({ username });

const setup = async () => {
  const admin = await createUser("adm");
  const editor = await createUser("ed");
  const editor2 = await createUser("ed2");
  const reader = await createUser("reader");
  const page = await createPage(admin);
  await addEditor(admin, page.id, editor.username);
  await addEditor(admin, page.id, editor2.username);
  return { admin, editor, editor2, reader, page };
};

describe("posts", () => {
  it("members create posts with text and images; ids are UUIDs and timestamps are timezone-aware", async () => {
    const { admin, page } = await setup();
    const res = await api().post("/post").set(admin.auth).field("pageId", page.id).field("content", "Hello")
      .attach("images", PNG_BYTES, { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    const post = res.body.data;
    expect(post.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.author.username).toBe(admin.username);
    expect(post.images).toHaveLength(1);
    expect(post.createdAt).toMatch(/Z$/);
    expect(post.updatedAt).toMatch(/Z$/);
    expect(post._id).toBeUndefined();
    expect(post.__v).toBeUndefined();
    expect(uploadedFilesOnDisk("posts")).toHaveLength(1);
  });

  it("requires content or an image, a valid page and membership", async () => {
    const { admin, reader, page } = await setup();
    const empty = await api().post("/post").set(admin.auth).field("pageId", page.id);
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("EMPTY_POST");
    expect((await api().post("/post").set(reader.auth).field("pageId", page.id).field("content", "x")).status).toBe(403);
    expect((await api().post("/post").set(admin.auth).field("pageId", "bad").field("content", "x")).status).toBe(400);
    expect((await api().post("/post").set(admin.auth).field("pageId", "00000000-0000-4000-8000-000000000000").field("content", "x")).status).toBe(404);
    expect((await api().post("/post").field("pageId", page.id).field("content", "x")).status).toBe(401);
  });

  it("leaves no orphan upload when the request is rejected after the file was received", async () => {
    const { reader, page } = await setup();
    const res = await api().post("/post").set(reader.auth).field("pageId", page.id).field("content", "x")
      .attach("images", PNG_BYTES, { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(403);
    expect(uploadedFilesOnDisk("posts")).toHaveLength(0);
  });

  it("gets a single post; unknown or malformed ids give 404 / 400", async () => {
    const { admin, reader, page } = await setup();
    const post = await createPost(admin, page.id, "single");
    expect((await api().get(`/post/${post.id}`).set(reader.auth)).body.data.content).toBe("single");
    expect((await api().get("/post/00000000-0000-4000-8000-000000000000").set(reader.auth)).status).toBe(404);
    expect((await api().get("/post/not-a-uuid").set(reader.auth)).status).toBe(400);
  });

  it("only the author can edit; updatedAt changes; reads show the edit immediately", async () => {
    const { admin, editor, page } = await setup();
    const post = await createPost(editor, page.id, "v1");
    expect((await api().get(`/post/${post.id}`).set(editor.auth)).body.data.content).toBe("v1"); // warm cache
    expect((await api().patch(`/post/${post.id}`).set(admin.auth).send({ content: "admin edit" })).status).toBe(403);
    await new Promise((r) => setTimeout(r, 15));
    const res = await api().patch(`/post/${post.id}`).set(editor.auth).send({ content: "v2" });
    expect(res.status).toBe(200);
    expect(Date.parse(res.body.data.updatedAt)).toBeGreaterThan(Date.parse(res.body.data.createdAt));
    expect((await api().get(`/post/${post.id}`).set(editor.auth)).body.data.content).toBe("v2");
    expect((await api().patch(`/post/${post.id}`).set(editor.auth).send({})).status).toBe(400);
  });

  it("an author who left the page can no longer edit", async () => {
    const { editor, page } = await setup();
    const post = await createPost(editor, page.id, "v1");
    await api().delete(`/page/${page.id}/members/me`).set(editor.auth);
    expect((await api().patch(`/post/${post.id}`).set(editor.auth).send({ content: "again" })).status).toBe(403);
  });

  it("replacing images deletes the old files from disk; removeImages clears them", async () => {
    const { admin, page } = await setup();
    const created = await api().post("/post").set(admin.auth).field("pageId", page.id).field("content", "pic")
      .attach("images", PNG_BYTES, { filename: "a.png", contentType: "image/png" });
    const [oldImage] = created.body.data.images as string[];
    const edited = await api().patch(`/post/${created.body.data.id}`).set(admin.auth)
      .attach("images", PNG_BYTES, { filename: "b.png", contentType: "image/png" });
    expect(edited.status).toBe(200);
    expect(edited.body.data.images[0]).not.toBe(oldImage);
    expect(uploadedFilesOnDisk("posts")).toEqual([edited.body.data.images[0].split("/").pop()]);
    expect((await api().get(oldImage)).status).toBe(404);
    const cleared = await api().patch(`/post/${created.body.data.id}`).set(admin.auth).field("removeImages", "true");
    expect(cleared.body.data.images).toEqual([]);
    expect(uploadedFilesOnDisk("posts")).toHaveLength(0);
  });

  it("author or page admin can delete; other editors and readers cannot", async () => {
    const { admin, editor, editor2, reader, page } = await setup();
    const own = await createPost(editor, page.id, "mine");
    const other = await createPost(editor, page.id, "also mine");
    expect((await api().delete(`/post/${own.id}`).set(editor2.auth)).status).toBe(403);
    expect((await api().delete(`/post/${own.id}`).set(reader.auth)).status).toBe(403);
    expect((await api().delete(`/post/${own.id}`).set(editor.auth)).status).toBe(202);
    expect((await api().delete(`/post/${other.id}`).set(admin.auth)).status).toBe(202); // admin moderation
    expect((await api().delete(`/post/${other.id}`).set(admin.auth)).status).toBe(404);
  });

  it("lists page posts and my posts, paginated and newest first", async () => {
    const { admin, editor, reader, page } = await setup();
    for (let i = 0; i < 5; i++) await createPost(i % 2 ? editor : admin, page.id, `p${i}`);
    const first = await api().get(`/post/page/${page.id}?size=2`).set(reader.auth);
    const second = await api().get(`/post/page/${page.id}?size=2&position=2`).set(reader.auth);
    const last = await api().get(`/post/page/${page.id}?size=2&position=4`).set(reader.auth);
    expect([first, second, last].flatMap((r) => r.body.data.items.map((p: { content: string }) => p.content))).toEqual(["p4", "p3", "p2", "p1", "p0"]);
    expect(last.body.data.pageInfo.hasNextPage).toBe(false);
    expect((await api().get("/post/me").set(editor.auth)).body.data.items).toHaveLength(2);
    expect((await api().get("/post/page/00000000-0000-4000-8000-000000000000").set(reader.auth)).status).toBe(404);
  });
});

describe("comments and replies", () => {
  const comment = (user: TestUser, postId: string, body: Record<string, unknown>) =>
    api().post(`/comments/post/${postId}`).set(user.auth).send(body);

  it("any authenticated user (even a non-member) can comment and reply; replies have depth 1 only", async () => {
    const { admin, reader, page } = await setup();
    const post = await createPost(admin, page.id);
    const top = await comment(reader, post.id, { content: "nice" });
    expect(top.status).toBe(201);
    expect(top.body.data.parentCommentId).toBeNull();
    const reply = await comment(admin, post.id, { content: "thanks", parentCommentId: top.body.data.id });
    expect(reply.status).toBe(201);
    expect(reply.body.data.parentCommentId).toBe(top.body.data.id);
    const nested = await comment(reader, post.id, { content: "nope", parentCommentId: reply.body.data.id });
    expect(nested.status).toBe(400);
    expect(nested.body.error.code).toBe("REPLY_DEPTH_EXCEEDED");
  });

  it("validates content, parents and posts", async () => {
    const { admin, reader, page } = await setup();
    const post = await createPost(admin, page.id);
    const other = await createPost(admin, page.id, "other");
    const top = await comment(reader, post.id, { content: "c" });
    expect((await comment(reader, post.id, { content: "" })).status).toBe(400);
    expect((await comment(reader, post.id, { content: "x".repeat(2001) })).status).toBe(400);
    expect((await comment(reader, "00000000-0000-4000-8000-000000000000", { content: "x" })).status).toBe(404);
    expect((await comment(reader, post.id, { content: "x", parentCommentId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await comment(reader, other.id, { content: "x", parentCommentId: top.body.data.id })).body.error.code).toBe("PARENT_COMMENT_MISMATCH");
    expect((await api().post(`/comments/post/${post.id}`).send({ content: "x" })).status).toBe(401);
  });

  it("authors edit their own comments only", async () => {
    const { admin, reader, page } = await setup();
    const post = await createPost(admin, page.id);
    const created = await comment(reader, post.id, { content: "first" });
    const id = created.body.data.id;
    expect((await api().patch(`/comments/${id}`).set(admin.auth).send({ content: "hijack" })).status).toBe(403);
    const res = await api().patch(`/comments/${id}`).set(reader.auth).send({ content: "edited" });
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe("edited");
    expect((await api().patch(`/comments/${id}`).set(reader.auth).send({ content: "" })).status).toBe(400);
  });

  it("deleting: author yes, page admin yes (any comment), editor/other no; deleting a comment removes its replies", async () => {
    const { admin, editor, reader, page } = await setup();
    const stranger = await createUser("str");
    const post = await createPost(admin, page.id);
    const top = (await comment(reader, post.id, { content: "top" })).body.data;
    await comment(stranger, post.id, { content: "r1", parentCommentId: top.id });
    await comment(stranger, post.id, { content: "r2", parentCommentId: top.id });
    expect((await api().delete(`/comments/${top.id}`).set(editor.auth)).status).toBe(403);
    expect((await api().delete(`/comments/${top.id}`).set(stranger.auth)).status).toBe(403);
    const res = await api().delete(`/comments/${top.id}`).set(admin.auth); // page admin, not the author
    expect(res.status).toBe(200);
    expect(res.body.data.deletedReplies).toBe(2);
    expect(await CommentModel.countDocuments({ postId: post.id })).toBe(0);
    const mine = (await comment(reader, post.id, { content: "mine" })).body.data;
    expect((await api().delete(`/comments/${mine.id}`).set(reader.auth)).status).toBe(200);
    expect((await api().delete(`/comments/${mine.id}`).set(reader.auth)).status).toBe(404);
  });

  it("lists top-level comments (with replyCount) and replies separately, both paginated and stable", async () => {
    const { admin, reader, page } = await setup();
    const post = await createPost(admin, page.id);
    const tie = new Date("2026-02-02T00:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await CommentModel.collection.insertOne({ _id: id, postId: post.id, pageId: page.id, accountId: reader.accountId, content: `c${i}`, parentCommentId: null, createdAt: tie, updatedAt: tie } as never);
    }
    for (let i = 0; i < 4; i++) await comment(admin, post.id, { content: `r${i}`, parentCommentId: ids[0] });

    const seen: string[] = [];
    for (const position of [0, 3, 6]) {
      const res = await api().get(`/comments/post/${post.id}?size=3&position=${position}`).set(reader.auth);
      seen.push(...res.body.data.items.map((c: { id: string }) => c.id));
      expect(res.body.data.items.every((c: { parentCommentId: string | null }) => c.parentCommentId === null)).toBe(true);
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const all = await api().get(`/comments/post/${post.id}?size=50`).set(reader.auth);
    expect(all.body.data.items.map((c: { id: string }) => c.id)).toEqual(seen);
    expect(all.body.data.items.find((c: { id: string }) => c.id === ids[0]).replyCount).toBe(4);

    const replies1 = await api().get(`/comments/${ids[0]}/replies?size=3`).set(reader.auth);
    const replies2 = await api().get(`/comments/${ids[0]}/replies?size=3&position=3`).set(reader.auth);
    expect(replies1.body.data.items.map((r: { content: string }) => r.content)).toEqual(["r0", "r1", "r2"]);
    expect(replies1.body.data.pageInfo.hasNextPage).toBe(true);
    expect(replies2.body.data.items.map((r: { content: string }) => r.content)).toEqual(["r3"]);
    expect((await api().get(`/comments/${replies1.body.data.items[0].id}/replies`).set(reader.auth)).status).toBe(400);
    expect((await api().get(`/comments/post/${post.id}?size=0`).set(reader.auth)).status).toBe(400);
  });
});

describe("reactions", () => {
  const react = (user: TestUser, postId: string, type: unknown) => api().post(`/reactions/post/${postId}`).set(user.auth).send({ type });

  it("accepts exactly the six reaction types", async () => {
    const { admin, reader, page } = await setup();
    const post = await createPost(admin, page.id);
    for (const type of ["like", "love", "haha", "wow", "sad", "angry"]) expect((await react(reader, post.id, type)).status).toBe(200);
    for (const type of ["dislike", "LIKE", "", 5, null]) {
      const res = await react(reader, post.id, type);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(await ReactionModel.countDocuments({ postId: post.id })).toBe(1);
  });

  it("one reaction per user per post; changing replaces; counts and my reaction are returned; removal is idempotent", async () => {
    const { admin, reader, page } = await setup();
    const fan = await createUser("fan");
    const post = await createPost(admin, page.id);
    await react(reader, post.id, "like");
    await react(fan, post.id, "like");
    const changed = await react(reader, post.id, "love");
    expect(changed.body.data.myReaction).toBe("love");
    expect(changed.body.data.counts).toEqual({ like: 1, love: 1, haha: 0, wow: 0, sad: 0, angry: 0, total: 2 });
    expect(await ReactionModel.countDocuments({ postId: post.id, accountId: reader.accountId })).toBe(1);

    const removed = await api().delete(`/reactions/post/${post.id}`).set(reader.auth);
    expect(removed.body.data.myReaction).toBeNull();
    expect(removed.body.data.counts.total).toBe(1);
    expect((await api().delete(`/reactions/post/${post.id}`).set(reader.auth)).status).toBe(200);
    expect((await react(reader, "00000000-0000-4000-8000-000000000000", "like")).status).toBe(404);
  });

  itAtomic("simultaneous reactions by the same user never create two rows", async () => {
    const { admin, reader, page } = await setup();
    const post = await createPost(admin, page.id);
    const results = await Promise.all(["like", "love", "wow", "sad", "like", "angry"].map((t) => react(reader, post.id, t)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await ReactionModel.countDocuments({ postId: post.id, accountId: reader.accountId })).toBe(1);
  });

  it("lists reacting users, filterable by type, paginated; counts ignore the filter", async () => {
    const { admin, page } = await setup();
    const post = await createPost(admin, page.id);
    const users: TestUser[] = [];
    for (let i = 0; i < 7; i++) users.push(await createUser("u"));
    for (const [i, user] of users.entries()) await react(user, post.id, i < 4 ? "like" : "wow");

    const all = await api().get(`/reactions/post/${post.id}?size=50`).set(admin.auth);
    expect(all.body.data.items).toHaveLength(7);
    expect(all.body.data.items[0]).toEqual(expect.objectContaining({ username: expect.any(String), type: expect.any(String), reactedAt: expect.any(String) }));
    expect(JSON.stringify(all.body)).not.toContain("@example.test");

    const likes1 = await api().get(`/reactions/post/${post.id}?type=like&size=3`).set(admin.auth);
    const likes2 = await api().get(`/reactions/post/${post.id}?type=like&size=3&position=3`).set(admin.auth);
    expect(likes1.body.data.items).toHaveLength(3);
    expect(likes1.body.data.pageInfo.hasNextPage).toBe(true);
    expect(likes2.body.data.items).toHaveLength(1);
    expect([...likes1.body.data.items, ...likes2.body.data.items].every((r: { type: string }) => r.type === "like")).toBe(true);
    expect(likes1.body.data.counts).toMatchObject({ like: 4, wow: 3, total: 7 });
    expect((await api().get(`/reactions/post/${post.id}?type=bogus`).set(admin.auth)).status).toBe(400);
    expect((await api().get(`/reactions/post/${post.id}?size=100`).set(admin.auth)).status).toBe(400);
  });

  it("the same reaction list is stable across repeated requests", async () => {
    const { admin, page } = await setup();
    const post = await createPost(admin, page.id);
    for (let i = 0; i < 6; i++) await react(await createUser("s"), post.id, "haha");
    const a = await api().get(`/reactions/post/${post.id}?size=2&position=2`).set(admin.auth);
    const b = await api().get(`/reactions/post/${post.id}?size=2&position=2`).set(admin.auth);
    expect(a.body.data.items).toEqual(b.body.data.items);
  });
});

describe("subscriber interaction", () => {
  it("a subscriber sees the post in the feed and can comment and react on it", async () => {
    const { admin, reader, page } = await setup();
    const post = await createPost(admin, page.id, "for subscribers");
    await subscribe(reader, page.id);
    expect((await api().get("/feed").set(reader.auth)).body.data.items[0].id).toBe(post.id);
    expect((await api().post(`/comments/post/${post.id}`).set(reader.auth).send({ content: "hi" })).status).toBe(201);
    expect((await api().post(`/reactions/post/${post.id}`).set(reader.auth).send({ type: "love" })).status).toBe(200);
    await api().delete(`/post/${post.id}`).set(admin.auth);
    await drainCleanup();
    expect(await CommentModel.countDocuments({ postId: post.id })).toBe(0);
    expect(await ReactionModel.countDocuments({ postId: post.id })).toBe(0);
  });
});
