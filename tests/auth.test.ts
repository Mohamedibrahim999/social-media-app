import {
  api, createUser, itAtomic, memoryOutbox, redisClient, resetRateLimits, resetState, setupInfrastructure, teardownInfrastructure, uniqueName,
} from "./support/helpers";
import { AccountModel } from "../src/modules/auth/auth.model";
import { TokenAncestryModel } from "../src/modules/auth/token-ancestry.model";
import { OTP_MAX_ATTEMPTS } from "../src/modules/auth/otp.service";

beforeAll(setupInfrastructure);
afterAll(teardownInfrastructure);
beforeEach(async () => {
  await resetState();
});

const register = (body: Record<string, unknown>) => api().post("/auth/register").send(body);
const newCreds = () => {
  const username = uniqueName("reg");
  return { username, email: `${username}@example.test`, password: "CorrectHorse9!" };
};

const allRedisEntries = async () => {
  const entries: string[] = [];
  for await (const keys of redisClient.scanIterator({ MATCH: "*", COUNT: 200 })) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const type = await redisClient.type(key);
      entries.push(key, type === "string" ? ((await redisClient.get(key)) ?? "") : "");
    }
  }
  return entries.join("\n");
};

describe("registration", () => {
  it("creates an account and a profile", async () => {
    const creds = newCreds();
    const res = await register(creds);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ username: creds.username, email: creds.email });
    expect(res.body.data.externalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data.passwordHash).toBeUndefined();
    const stored = await AccountModel.findOne({ username: creds.username });
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt hash, never the password
  });

  it("rejects invalid input with a structured 400 (not a 500)", async () => {
    const res = await register({ username: "ab", email: "not-an-email", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(["email", "password", "username"]);
  });

  it("reports a taken username (public identifier) with 409", async () => {
    const creds = newCreds();
    await register(creds);
    await resetRateLimits();
    const res = await register({ ...newCreds(), username: creds.username });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("USERNAME_TAKEN");
  });

  it("does NOT reveal that an e-mail is already registered (same 201 shape, no new account)", async () => {
    const creds = newCreds();
    const first = await register(creds);
    await resetRateLimits();
    const second = await register({ ...newCreds(), email: creds.email });
    expect(second.status).toBe(201);
    expect(Object.keys(second.body.data).sort()).toEqual(Object.keys(first.body.data).sort());
    expect(second.body.message).toBe(first.body.message);
    expect(await AccountModel.countDocuments({ email: creds.email })).toBe(1);
  });

  it("rate-limits registration (429 with the standard error body)", async () => {
    let last = await register(newCreds());
    for (let i = 0; i < 10; i++) last = await register(newCreds()); // limit is 10 per IP per 15 minutes
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(last.headers["retry-after"]).toBeDefined();
  });
});

describe("login with username", () => {
  it("returns an access + refresh token with the documented lifetimes", async () => {
    const user = await createUser("login");
    const res = await api().post("/auth/login").send({ identifier: user.username, password: user.password });
    expect(res.status).toBe(200);
    expect(res.body.data.requiresVerification).toBe(false);
    expect(res.body.data.accessTokenExpiresIn).toBe(15 * 60);
    expect(res.body.data.refreshTokenExpiresIn).toBe(7 * 24 * 60 * 60);
    const me = await api().get("/profile/me").set("Authorization", `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("answers wrong password and unknown account identically (no enumeration)", async () => {
    const user = await createUser("enum");
    const wrongPassword = await api().post("/auth/login").send({ identifier: user.username, password: "WrongPassword1!" });
    const unknown = await api().post("/auth/login").send({ identifier: "nobody_here", password: "WrongPassword1!" });
    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe(wrongPassword.body.error.code);
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns 400, not 500, for a malformed login body", async () => {
    const res = await api().post("/auth/login").send({ username: "seed_operator", password: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rate-limits login per IP and per identifier", async () => {
    const user = await createUser("rl");
    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (await api().post("/auth/login").send({ identifier: user.username, password: "Wrong-password1" })).status;
    }
    expect(status).toBe(429);
  });

  it("does not lock out many different accounts behind one shared IP (limits are per account, IP ceiling is generous)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      statuses.push((await api().post("/auth/login").send({ identifier: `someone_${i}`, password: "Wrong-password1" })).status);
    }
    expect(statuses.every((status) => status === 401)).toBe(true);
  });

  it("is not bypassable by spoofing X-Forwarded-For", async () => {
    const user = await createUser("spoof");
    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (
        await api().post("/auth/login").set("X-Forwarded-For", `10.0.0.${i}`).send({ identifier: user.username, password: "Wrong-password1" })
      ).status;
    }
    expect(status).toBe(429);
  });
});

describe("login with e-mail + OTP", () => {
  const startEmailLogin = async () => {
    const user = await createUser("otp");
    const res = await api().post("/auth/login").send({ identifier: user.email, password: user.password });
    return { user, res };
  };
  const lastCode = () => /(\d{6})/.exec(memoryOutbox[memoryOutbox.length - 1].text)![1];

  it("sends a 6-digit code by e-mail and never returns or stores it in clear", async () => {
    const { user, res } = await startEmailLogin();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requiresVerification: true, externalId: user.accountId });
    expect(JSON.stringify(res.body)).not.toMatch(/\b\d{6}\b/);
    expect(memoryOutbox).toHaveLength(1);
    expect(memoryOutbox[0].to).toBe(user.email);
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(await allRedisEntries()).not.toContain(code); // only a hash is in Redis
    expect(await allRedisEntries()).not.toContain(user.password);
  });

  it("expires after 5 minutes", async () => {
  const { user } = await startEmailLogin();
  const ttl = await redisClient.ttl(`auth:login:otp:${user.accountId}`);
  expect(ttl).toBeGreaterThan(290);
  expect(ttl).toBeLessThanOrEqual(300);
});
  it("verifies the code once and issues tokens; the code is single-use", async () => {
    const { user } = await startEmailLogin();
    const code = lastCode();
    const ok = await api().post("/auth/login/verify").send({ externalId: user.accountId, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeDefined();
    const again = await api().post("/auth/login/verify").send({ externalId: user.accountId, code });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("INVALID_VERIFICATION_CODE");
  });

  it("a new code invalidates the previous one", async () => {
    const { user } = await startEmailLogin();
    const oldCode = lastCode();
    await api().post("/auth/login").send({ identifier: user.email, password: user.password });
    const newCode = lastCode();
    if (newCode !== oldCode) {
      const res = await api().post("/auth/login/verify").send({ externalId: user.accountId, code: oldCode });
      expect(res.status).toBe(401);
    }
    const ok = await api().post("/auth/login/verify").send({ externalId: user.accountId, code: newCode });
    expect(ok.status).toBe(200);
  });

  it("limits verification attempts, then burns the code even if the right one follows", async () => {
    const { user } = await startEmailLogin();
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      const res = await api().post("/auth/login/verify").send({ externalId: user.accountId, code: wrong });
      expect(res.status).toBe(401);
    }
    const res = await api().post("/auth/login/verify").send({ externalId: user.accountId, code });
    expect(res.status).toBe(401);
  });

  it("gives the same error for an unknown account id and for a wrong code", async () => {
    const { user } = await startEmailLogin();
    const wrong = await api().post("/auth/login/verify").send({ externalId: user.accountId, code: "000000" });
    const unknown = await api().post("/auth/login/verify").send({ externalId: "00000000-0000-4000-8000-000000000000", code: "000000" });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
  });

  it("rejects malformed codes with 400 and rate-limits verification", async () => {
    const { user } = await startEmailLogin();
    const bad = await api().post("/auth/login/verify").send({ externalId: user.accountId, code: "12ab56" });
    expect(bad.status).toBe(400);
    let status = 0;
    for (let i = 0; i < 12; i++) {
      status = (await api().post("/auth/login/verify").send({ externalId: user.accountId, code: "000000" })).status;
    }
    expect(status).toBe(429);
  });
});

describe("refresh-token rotation", () => {
  it("rotates: new pair differs, parent/child lineage and hashes are recorded, raw token never stored", async () => {
    const user = await createUser("rot");
    const res = await api().post("/auth/refresh").send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);
    const next = res.body.data.refreshToken as string;
    expect(next).not.toBe(user.refreshToken);

    const records = await TokenAncestryModel.find({ accountId: user.accountId }).sort({ createdAt: 1 });
    expect(records).toHaveLength(2);
    const [oldRec, newRec] = records;
    expect(oldRec.status).toBe("superseded");
    expect(oldRec.replacedByTokenId).toBe(newRec.tokenId);
    expect(newRec.parentTokenId).toBe(oldRec.tokenId);
    expect(newRec.familyId).toBe(oldRec.familyId);
    expect(newRec.status).toBe("active");
    expect(newRec.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(records)).not.toContain(next);
    expect((await TokenAncestryModel.find()).some((r) => r.expiresAt.getTime() - Date.now() > 6.9 * 86400_000)).toBe(true);
  });

  it("detects reuse of a superseded token and revokes the whole sign-in chain", async () => {
    const user = await createUser("reuse");
    const first = await api().post("/auth/refresh").send({ refreshToken: user.refreshToken });
    const newest = first.body.data.refreshToken as string;

    const replay = await api().post("/auth/refresh").send({ refreshToken: user.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    const legit = await api().post("/auth/refresh").send({ refreshToken: newest }); // legit token is dead too
    expect(legit.status).toBe(401);
    const records = await TokenAncestryModel.find({ accountId: user.accountId });
    expect(records.every((r) => r.status === "revoked")).toBe(true);
    // ...and so is the access token of that chain
    expect((await api().get("/profile/me").set("Authorization", `Bearer ${first.body.data.accessToken}`)).status).toBe(401);
  });

  it("reuse in one sign-in chain does not touch another device's chain", async () => {
    const user = await createUser("two");
    const other = await api().post("/auth/login").send({ identifier: user.username, password: user.password });
    await api().post("/auth/refresh").send({ refreshToken: user.refreshToken });
    await api().post("/auth/refresh").send({ refreshToken: user.refreshToken }); // reuse => chain 1 revoked
    const stillOk = await api().post("/auth/refresh").send({ refreshToken: other.body.data.refreshToken });
    expect(stillOk.status).toBe(200);
  });

  itAtomic("two concurrent refreshes with the same token: exactly one wins", async () => {
    const user = await createUser("race");
    const results = await Promise.all([
      api().post("/auth/refresh").send({ refreshToken: user.refreshToken }),
      api().post("/auth/refresh").send({ refreshToken: user.refreshToken }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("rejects garbage and wrong-type tokens generically", async () => {
    const user = await createUser("garbage");
    expect((await api().post("/auth/refresh").send({ refreshToken: "x".repeat(40) })).status).toBe(401);
    expect((await api().post("/auth/refresh").send({ refreshToken: user.accessToken })).status).toBe(401); // access token is not a refresh token
    expect((await api().post("/auth/refresh").send({})).status).toBe(400);
  });

  it("rate-limits refresh", async () => {
    let status = 0;
    for (let i = 0; i < 61; i++) status = (await api().post("/auth/refresh").send({ refreshToken: "x".repeat(40) })).status; // limit: 60 per IP
    expect(status).toBe(429);
  });
});

describe("logout and password change", () => {
  it("logout ends the current chain immediately (refresh AND access token) and is idempotent", async () => {
    const user = await createUser("out");
    const res = await api().post("/auth/logout").send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);
    expect((await api().post("/auth/refresh").send({ refreshToken: user.refreshToken })).status).toBe(401);
    expect((await api().get("/profile/me").set(user.auth)).status).toBe(401);
    expect((await api().post("/auth/logout").send({ refreshToken: user.refreshToken })).status).toBe(200);
  });

  it("logout-all revokes every device but leaves the account usable", async () => {
    const user = await createUser("all");
    const second = await api().post("/auth/login").send({ identifier: user.username, password: user.password });
    const res = await api().post("/auth/logout-all").send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);
    expect((await api().post("/auth/refresh").send({ refreshToken: second.body.data.refreshToken })).status).toBe(401);
    expect((await api().get("/profile/me").set("Authorization", `Bearer ${second.body.data.accessToken}`)).status).toBe(401);
    expect((await api().post("/auth/login").send({ identifier: user.username, password: user.password })).status).toBe(200);
  });

  it("password change invalidates all old sessions and the old password", async () => {
    const user = await createUser("pw");
    const other = await api().post("/auth/login").send({ identifier: user.username, password: user.password });
    const res = await api().patch("/auth/password").set(user.auth).send({ currentPassword: user.password, newPassword: "BrandNewPass9!" });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined(); // fresh session for the device that changed it
    expect((await api().post("/auth/refresh").send({ refreshToken: other.body.data.refreshToken })).status).toBe(401);
    expect((await api().post("/auth/refresh").send({ refreshToken: user.refreshToken })).status).toBe(401);
    expect((await api().get("/profile/me").set(user.auth)).status).toBe(401);
    expect((await api().post("/auth/login").send({ identifier: user.username, password: user.password })).status).toBe(401);
    expect((await api().post("/auth/login").send({ identifier: user.username, password: "BrandNewPass9!" })).status).toBe(200);
    expect((await api().get("/profile/me").set("Authorization", `Bearer ${res.body.data.accessToken}`)).status).toBe(200);
  });

  it("password change requires the correct current password and a different new one", async () => {
    const user = await createUser("pw2");
    const wrong = await api().patch("/auth/password").set(user.auth).send({ currentPassword: "nope-nope-1", newPassword: "BrandNewPass9!" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("INVALID_CURRENT_PASSWORD");
    const same = await api().patch("/auth/password").set(user.auth).send({ currentPassword: user.password, newPassword: user.password });
    expect(same.status).toBe(400);
  });

  it("protected routes require a valid bearer token", async () => {
    expect((await api().get("/profile/me")).status).toBe(401);
    expect((await api().get("/profile/me").set("Authorization", "Bearer abc.def.ghi")).status).toBe(401);
    expect((await api().get("/profile/me").set("Authorization", "Basic xyz")).status).toBe(401);
  });
});

describe("redis hygiene and trace header", () => {
  it("Redis never contains password hashes, refresh tokens, access tokens or e-mail addresses", async () => {
    const user = await createUser("hyg");
    await api().post("/auth/login").send({ identifier: user.email, password: user.password }); // creates OTP state
    const refreshed = await api().post("/auth/refresh").send({ refreshToken: user.refreshToken });
    await api().get("/profile/me").set(user.auth);
    const hash = (await AccountModel.findOne({ username: user.username }))!.passwordHash;
    const dump = await allRedisEntries();
    for (const secret of [hash, user.refreshToken, refreshed.body.data.refreshToken, user.accessToken, user.email, user.password]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("echoes a client trace ref on success and error responses; generates one otherwise", async () => {
    const ok = await api().get("/health").set("X-Tapi-Trace-Ref", "client-trace-123");
    expect(ok.headers["x-tapi-trace-ref"]).toBe("client-trace-123");
    const err = await api().get("/profile/me").set("X-Tapi-Trace-Ref", "client-trace-456");
    expect(err.status).toBe(401);
    expect(err.headers["x-tapi-trace-ref"]).toBe("client-trace-456");
    expect(err.body.error.traceRef).toBe("client-trace-456");
    const generated = await api().get("/health");
    expect(generated.headers["x-tapi-trace-ref"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("adds the trace header to 404s, malformed JSON and unsafe client values", async () => {
    const notFound = await api().get("/does/not/exist");
    expect(notFound.status).toBe(404);
    expect(notFound.headers["x-tapi-trace-ref"]).toBeDefined();
    const badJson = await api().post("/auth/login").set("Content-Type", "application/json").send("{ not json");
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe("INVALID_JSON");
    expect(badJson.headers["x-tapi-trace-ref"]).toBeDefined();
    const unsafe = await api().get("/health").set("X-Tapi-Trace-Ref", "bad value with spaces & <script>");
    expect(unsafe.status).toBe(200);
    expect(unsafe.headers["x-tapi-trace-ref"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never leaks stack traces for unexpected errors outside development", async () => {
    const res = await api().get("/profile/%E0%A4%A"); // malformed URI
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules/);
  });
});
