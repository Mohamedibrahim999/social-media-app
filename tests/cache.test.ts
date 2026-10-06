import { api, createPage, createPost, createUser, redisClient, resetState, setupInfrastructure, subscribe, teardownInfrastructure } from "./support/helpers";
import { getCache, setCache, readThrough, buildKey, deleteCache, deleteCacheByPattern } from "../src/common/cache/cache.service";
import { AccountModel } from "../src/modules/auth/auth.model";

beforeAll(setupInfrastructure);
afterAll(teardownInfrastructure);
beforeEach(resetState);

const cacheKeys = async () => {
  const found: string[] = [];
  for await (const keys of redisClient.scanIterator({ MATCH: "tapi:test:*", COUNT: 200 })) found.push(...(Array.isArray(keys) ? keys : [keys]));
  return found.filter((k) => !k.startsWith("tapi:test:stats:") && !k.startsWith("tapi:test:ver:"));
};

describe("read-through cache", () => {
  it("serves Redis first, falls back to the loader on a miss, then caches with a TTL", async () => {
    const loader = jest.fn().mockResolvedValue({ value: 1 });
    expect(await readThrough("demo:key", loader, 60)).toEqual({ value: 1 }); // miss -> loader
    expect(await readThrough("demo:key", loader, 60)).toEqual({ value: 1 }); // hit  -> no loader
    expect(loader).toHaveBeenCalledTimes(1);
    const ttl = await redisClient.ttl(buildKey("demo:key"));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("every cache key starts with CACHE_EPOCH_PREFIX and has a TTL", async () => {
    const admin = await createUser("adm");
    const reader = await createUser("rd");
    const page = await createPage(admin);
    const post = await createPost(admin, page.id);
    await subscribe(reader, page.id);
    await api().get(`/page/${page.id}`).set(reader.auth);
    await api().get(`/post/${post.id}`).set(reader.auth);
    await api().get("/feed").set(reader.auth);
    await api().get(`/post/page/${page.id}`).set(reader.auth);
    const keys = await cacheKeys();
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const key of keys) {
      expect(key.startsWith("tapi:test:")).toBe(true);
      expect(await redisClient.ttl(key)).toBeGreaterThan(0);
    }
    // nothing application-related lives outside the prefix except auth/rate-limit bookkeeping
    for await (const raw of redisClient.scanIterator({ MATCH: "*", COUNT: 200 })) {
      for (const key of Array.isArray(raw) ? raw : [raw]) {
        expect(key.startsWith("tapi:test:") || key.startsWith("auth:login:") || key.startsWith("ratelimit:")).toBe(true);
      }
    }
  });

  it("a cache hit really comes from Redis (stale value injected into Redis is returned)", async () => {
    const admin = await createUser("adm");
    const page = await createPage(admin, "Real name");
    await api().get(`/page/${page.id}`).set(admin.auth);
    const key = buildKey(`page:id:${page.id}`);
    const cached = JSON.parse((await redisClient.get(key))!);
    await redisClient.set(key, JSON.stringify({ ...cached, name: "FROM REDIS" }), { EX: 60 });
    expect((await api().get(`/page/${page.id}`).set(admin.auth)).body.data.name).toBe("FROM REDIS");
    await api().patch(`/page/${page.id}`).set(admin.auth).send({ name: "Updated" }); // write -> invalidate
    expect((await api().get(`/page/${page.id}`).set(admin.auth)).body.data.name).toBe("Updated");
  });

  it("writes are immediately visible: post create/edit/delete refresh the page post list", async () => {
    const admin = await createUser("adm");
    const page = await createPage(admin);
    const list = () => api().get(`/post/page/${page.id}`).set(admin.auth).then((r) => r.body.data.items.map((p: { content: string }) => p.content));
    expect(await list()).toEqual([]);
    const post = await createPost(admin, page.id, "one");
    expect(await list()).toEqual(["one"]);
    await api().patch(`/post/${post.id}`).set(admin.auth).send({ content: "two" });
    expect(await list()).toEqual(["two"]);
    await api().delete(`/post/${post.id}`).set(admin.auth);
    expect(await list()).toEqual([]);
  });

  it("admin transfer and member changes invalidate cached page data", async () => {
    const admin = await createUser("adm");
    const editor = await createUser("ed");
    const page = await createPage(admin);
    expect((await api().get(`/page/${page.id}`).set(admin.auth)).body.data.adminAccountId).toBe(admin.accountId);
    await api().post(`/page/${page.id}/members/editors`).set(admin.auth).send({ username: editor.username });
    await api().patch(`/page/${page.id}/members/admin`).set(admin.auth).send({ username: editor.username });
    expect((await api().get(`/page/${page.id}`).set(admin.auth)).body.data.adminAccountId).toBe(editor.accountId);
  });

  it("degrades to MongoDB when Redis operations fail (cache outage does not break reads)", async () => {
    const spy = jest.spyOn(redisClient, "get").mockRejectedValueOnce(new Error("redis down"));
    expect(await getCache("anything")).toBeNull();
    spy.mockRestore();
  });

  it("pattern invalidation removes only matching keys", async () => {
    await setCache("x:1", 1);
    await setCache("x:2", 2);
    await setCache("y:1", 3);
    await deleteCacheByPattern("x:*");
    expect(await getCache("x:1")).toBeNull();
    expect(await getCache("x:2")).toBeNull();
    expect(await getCache("y:1")).toBe(3);
    await deleteCache("y:1");
    expect(await getCache("y:1")).toBeNull();
  });
});

describe("Redis security", () => {
  it("shared cached data never contains e-mail addresses, password hashes or tokens", async () => {
    const admin = await createUser("adm");
    const reader = await createUser("rd");
    const page = await createPage(admin);
    const post = await createPost(admin, page.id);
    await subscribe(reader, page.id);
    await api().post(`/comments/post/${post.id}`).set(reader.auth).send({ content: "hi" });
    for (const url of [`/page/${page.id}`, `/post/${post.id}`, `/post/page/${page.id}`, "/feed", `/page/${page.id}/members`, "/post/me"]) {
      await api().get(url).set(reader.auth.Authorization ? reader.auth : admin.auth);
    }
    await api().get(`/post/me`).set(admin.auth);
    let dump = "";
    for await (const raw of redisClient.scanIterator({ MATCH: "*", COUNT: 200 })) {
      for (const key of Array.isArray(raw) ? raw : [raw]) dump += `${key}=${(await redisClient.type(key)) === "string" ? await redisClient.get(key) : ""}\n`;
    }
    const hashes = (await AccountModel.find()).map((a) => a.passwordHash);
    for (const secret of [admin.email, reader.email, ...hashes, admin.refreshToken, reader.refreshToken, admin.accessToken, reader.accessToken, "@example.test", "$2b$"]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe("health endpoint", () => {
  it("exposes cache hit ratio, key count and eviction count", async () => {
    const admin = await createUser("adm");
    const page = await createPage(admin);
    await api().get(`/page/${page.id}`).set(admin.auth); // miss
    await api().get(`/page/${page.id}`).set(admin.auth); // hit
    await api().get(`/page/${page.id}`).set(admin.auth); // hit
    await new Promise((r) => setTimeout(r, 100)); // counters are fire-and-forget
    const res = await api().get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.services).toEqual({ database: true, redis: true });
    expect(res.body.cache).toEqual({
      hitRatio: expect.any(Number),
      hits: expect.any(Number),
      misses: expect.any(Number),
      keyCount: expect.any(Number),
      evictionCount: expect.any(Number),
    });
    expect(res.body.cache.hits).toBeGreaterThanOrEqual(2);
    expect(res.body.cache.misses).toBeGreaterThanOrEqual(1);
    expect(res.body.cache.hitRatio).toBeGreaterThan(0);
    expect(res.body.cache.hitRatio).toBeLessThanOrEqual(1);
    expect(res.body.cache.keyCount).toBeGreaterThanOrEqual(1);
    expect(res.body.cache.keyCount).toBe((await cacheKeys()).length); // counts only cache keys, not OTP/rate-limit keys
  });
});
