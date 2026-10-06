import mongoose from "mongoose";
import {
  api, createPage, createPost, createUser, itAtomic, resetState, setupInfrastructure, subscribe, teardownInfrastructure,
} from "./support/helpers";
import { SubscriptionModel } from "../src/modules/subscription/subscription.model";
import { PostModel } from "../src/modules/post/post.model";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePagination } from "../src/common/pagination/pagination";

beforeAll(setupInfrastructure);
afterAll(teardownInfrastructure);
beforeEach(resetState);

const feed = (user: { auth: { Authorization: string } }, query = "") => api().get(`/feed${query}`).set(user.auth);

describe("subscriptions", () => {
  it("subscribe is idempotent: 201 first, 200 afterwards, never a duplicate row", async () => {
    const admin = await createUser("adm");
    const fan = await createUser("fan");
    const page = await createPage(admin);
    expect((await subscribe(fan, page.id)).status).toBe(201);
    expect((await subscribe(fan, page.id)).status).toBe(200);
    expect((await subscribe(fan, page.id)).status).toBe(200);
    expect(await SubscriptionModel.countDocuments({ accountId: fan.accountId, pageId: page.id })).toBe(1);
  });

  itAtomic("concurrent duplicate subscribes still leave exactly one row and no 5xx", async () => {
    const admin = await createUser("adm");
    const fan = await createUser("fan");
    const page = await createPage(admin);
    const results = await Promise.all(Array.from({ length: 6 }, () => subscribe(fan, page.id)));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await SubscriptionModel.countDocuments({ accountId: fan.accountId, pageId: page.id })).toBe(1);
  });

  it("unsubscribe is idempotent and harmless when not subscribed (body and path forms)", async () => {
    const admin = await createUser("adm");
    const fan = await createUser("fan");
    const page = await createPage(admin);
    const never = await api().delete(`/subscriptions/${page.id}`).set(fan.auth);
    expect(never.status).toBe(200);
    expect(never.body.data).toMatchObject({ subscribed: false, removed: false });
    await subscribe(fan, page.id);
    expect((await api().delete("/subscriptions").set(fan.auth).send({ pageId: page.id })).body.data.removed).toBe(true);
    expect((await api().delete(`/subscriptions/${page.id}`).set(fan.auth)).status).toBe(200);
  });

  it("validates the page id and refuses unknown pages", async () => {
    const fan = await createUser("fan");
    expect((await subscribe(fan, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await api().post("/subscriptions").set(fan.auth).send({ pageId: "nope" })).status).toBe(400);
    expect((await api().post("/subscriptions").send({ pageId: "x" })).status).toBe(401);
  });

  it("lists my subscribed pages with pagination", async () => {
    const admin = await createUser("adm");
    const fan = await createUser("fan");
    const pages = [await createPage(admin, "P1"), await createPage(admin, "P2"), await createPage(admin, "P3")];
    for (const page of pages) await subscribe(fan, page.id);
    const first = await api().get("/subscriptions/mine?size=2").set(fan.auth);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.pageInfo.hasNextPage).toBe(true);
    const second = await api().get("/subscriptions/mine?size=2&position=2").set(fan.auth);
    expect(second.body.data.items).toHaveLength(1);
    const ids = [...first.body.data.items, ...second.body.data.items].map((p: { id: string }) => p.id);
    expect(new Set(ids)).toEqual(new Set(pages.map((p) => p.id)));
  });

  it("only the page admin can list subscribers; no e-mail addresses are exposed", async () => {
    const admin = await createUser("adm");
    const editor = await createUser("ed");
    const fan = await createUser("fan");
    const page = await createPage(admin);
    await api().post(`/page/${page.id}/members/editors`).set(admin.auth).send({ username: editor.username });
    await subscribe(fan, page.id);
    expect((await api().get(`/subscriptions/page/${page.id}/subscribers`).set(fan.auth)).status).toBe(403);
    expect((await api().get(`/subscriptions/page/${page.id}/subscribers`).set(editor.auth)).status).toBe(403);
    const res = await api().get(`/subscriptions/page/${page.id}/subscribers`).set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ accountId: fan.accountId, username: fan.username });
    expect(JSON.stringify(res.body)).not.toContain(fan.email);
  });

  it("enforces uniqueness in the database (indexes exist)", async () => {
    const unique = async (collection: string, keys: string[]) => {
      const indexes = await mongoose.connection.db!.collection(collection).indexes();
      return indexes.some((i) => i.unique && JSON.stringify(Object.keys(i.key)) === JSON.stringify(keys));
    };
    expect(await unique("subscriptions", ["accountId", "pageId"])).toBe(true);
    expect(await unique("reactions", ["postId", "accountId"])).toBe(true);
    expect(await unique("pagemembers", ["pageId", "accountId"])).toBe(true);
    expect(await unique("accounts", ["username"])).toBe(true);
    expect(await unique("accounts", ["email"])).toBe(true);
    await expect(SubscriptionModel.create({ accountId: "a", pageId: "p" }).then(() => SubscriptionModel.create({ accountId: "a", pageId: "p" }))).rejects.toMatchObject({ code: 11000 });
  });
});

describe("feed", () => {
  it("contains only posts from subscribed pages, newest first, and nothing else", async () => {
    const adminA = await createUser("a");
    const adminB = await createUser("b");
    const reader = await createUser("reader");
    const pageA = await createPage(adminA, "A");
    const pageB = await createPage(adminB, "B");
    const postA = await createPost(adminA, pageA.id, "from A");
    await createPost(adminB, pageB.id, "from B (not subscribed)");
    await subscribe(reader, pageA.id);
    const res = await feed(reader);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((p: { id: string }) => p.id)).toEqual([postA.id]);
    expect(res.body.data.items[0].page).toMatchObject({ id: pageA.id, name: "A", picture: "/uploads/defaults/page.png" });
    expect(res.body.data.items[0].author).toMatchObject({ username: adminA.username, picture: "/uploads/defaults/profile.png" });
    expect(JSON.stringify(res.body)).not.toContain(adminA.email);
  });

  it("an empty subscription list yields an empty feed (no recommendations/trending), and being a member does not subscribe", async () => {
    const admin = await createUser("adm");
    const page = await createPage(admin);
    await createPost(admin, page.id);
    const res = await feed(admin);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.pageInfo.hasNextPage).toBe(false);
  });

  it("after unsubscribe the page disappears from the very next feed request (cache cannot serve it)", async () => {
    const admin = await createUser("adm");
    const reader = await createUser("reader");
    const page = await createPage(admin);
    await createPost(admin, page.id);
    await subscribe(reader, page.id);
    expect((await feed(reader)).body.data.items).toHaveLength(1);
    expect((await feed(reader)).body.data.items).toHaveLength(1); // second call is served from Redis
    await api().delete(`/subscriptions/${page.id}`).set(reader.auth);
    expect((await feed(reader)).body.data.items).toHaveLength(0);
    await subscribe(reader, page.id);
    expect((await feed(reader)).body.data.items).toHaveLength(1);
  });

  it("new, edited and deleted posts are visible in the feed immediately despite caching", async () => {
    const admin = await createUser("adm");
    const reader = await createUser("reader");
    const page = await createPage(admin);
    await subscribe(reader, page.id);
    expect((await feed(reader)).body.data.items).toHaveLength(0); // caches the empty page
    const post = await createPost(admin, page.id, "v1");
    expect((await feed(reader)).body.data.items.map((p: { content: string }) => p.content)).toEqual(["v1"]);
    await api().patch(`/post/${post.id}`).set(admin.auth).send({ content: "v2" });
    expect((await feed(reader)).body.data.items[0].content).toBe("v2");
    await api().delete(`/post/${post.id}`).set(admin.auth);
    expect((await feed(reader)).body.data.items).toHaveLength(0);
  });

  it("page renames show up in the feed right away (display data is never stale)", async () => {
    const admin = await createUser("adm");
    const reader = await createUser("reader");
    const page = await createPage(admin, "Old name");
    await createPost(admin, page.id);
    await subscribe(reader, page.id);
    expect((await feed(reader)).body.data.items[0].page.name).toBe("Old name");
    await api().patch(`/page/${page.id}`).set(admin.auth).send({ name: "New name" });
    expect((await feed(reader)).body.data.items[0].page.name).toBe("New name");
  });

  it("paginates 23 posts across pages with no gaps/duplicates, stable even with identical timestamps", async () => {
    const admin = await createUser("adm");
    const reader = await createUser("reader");
    const page = await createPage(admin);
    await subscribe(reader, page.id);
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    const docs = Array.from({ length: 23 }, (_, i) => ({
      pageId: page.id,
      accountId: admin.accountId,
      content: `p${i}`,
      images: [],
      createdAt: i < 10 ? sameInstant : new Date(sameInstant.getTime() + i * 1000), // 10 posts tie on createdAt
      updatedAt: sameInstant,
    }));
    await PostModel.collection.insertMany(docs.map((d) => ({ ...d, _id: crypto.randomUUID() })) as never);

    const seen: string[] = [];
    let position = 0;
    for (let guard = 0; guard < 10; guard++) {
      const res = await feed(reader, `?size=5&position=${position}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.items.map((p: { id: string }) => p.id));
      if (!res.body.data.pageInfo.hasNextPage) break;
      position = res.body.data.pageInfo.nextPosition;
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    const full = await feed(reader, "?size=50");
    expect(full.body.data.items.map((p: { id: string }) => p.id)).toEqual(seen); // identical order however it is paged
    const times = full.body.data.items.map((p: { createdAt: string }) => Date.parse(p.createdAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times); // newest first
  });

  it("runs pagination inside MongoDB (skip/limit/sort are sent to the database)", async () => {
    const admin = await createUser("adm");
    const reader = await createUser("reader");
    const page = await createPage(admin);
    await subscribe(reader, page.id);
    for (let i = 0; i < 8; i++) await createPost(admin, page.id, `p${i}`);
    const operations: { collection: string; method: string; options: Record<string, unknown> }[] = [];
    mongoose.set("debug", (collection: string, method: string, _query: unknown, options: Record<string, unknown>) => {
      operations.push({ collection, method, options });
    });
    try {
      const res = await feed(reader, "?size=3&position=2");
      expect(res.body.data.items).toHaveLength(3);
    } finally {
      mongoose.set("debug", false);
    }
    const postFind = operations.find((op) => op.collection === "posts" && op.method === "find");
    expect(postFind).toBeDefined();
    expect(postFind!.options).toMatchObject({ limit: 4, skip: 2, sort: { createdAt: -1, _id: -1 } }); // size+1 look-ahead row
  });

  it("validates pagination parameters", async () => {
    const reader = await createUser("reader");
    for (const query of ["?size=0", "?size=51", "?size=abc", "?position=-1", "?position=1.5", "?size=-3"]) {
      const res = await feed(reader, query);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect((await feed(reader, "?size=50&position=0")).status).toBe(200);
    expect((await feed(reader)).body.data.pageInfo).toMatchObject({ size: DEFAULT_PAGE_SIZE, position: 0 });
    expect({ DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE }).toEqual({ DEFAULT_PAGE_SIZE: 20, MAX_PAGE_SIZE: 50 });
    expect(parsePagination({})).toEqual({ size: 20, position: 0 });
  });
});
