# Audit Report – Tapi Social Media API

Scope: the uploaded `tapi_task.zip`, audited, fixed, tested and documented against the 25 requirement groups.
Method: read every module, reproduced the reported bug, fixed, then verified with build, lint, an integration test suite, `yarn seed`, `yarn dev` and the Postman collection run by newman against the live server.

## 1. Verification summary

| Check | Result |
|---|---|
| `yarn install --frozen-lockfile` | OK (`yarn.lock` present and up to date) |
| `yarn build` | **PASS** – exit 0, 0 errors |
| `yarn lint` | **PASS** – exit 0, **0 errors, 0 warnings** |
| `yarn test` | **PASS** – 7 suites, **114 tests: 110 passed, 0 failed, 4 skipped** (skips explained below) |
| `yarn seed` | **PASS** – 14 s on an empty DB; re-run completes (16 s) with identical counts and no duplicates (see §3) |
| `yarn dev` | **PASS** – `/health` ok, original login request returns **200** |
| Postman collection (newman, live server, cleanup worker running) | **PASS** – 114 requests executed, **0 failed**; 247 assertions, **0 failed** |
| Postman "SEED DEMO" folder on a freshly seeded DB | **PASS** – 9 requests, 25 assertions, 0 failed |
| Live Redis / MongoDB inspection | cache keys all under `CACHE_EPOCH_PREFIX`, TTL ≤ 300 s, **0** hashes/JWTs/e-mails in Redis values; sessions in Mongo show `active/superseded/revoked` with `tokenHash`, `familyId`, `parentTokenId`, `replacedByTokenId`; all 9 cleanup jobs reached `completed` |

**Number of tests:** 114 · **passed:** 110 · **failed:** 0 · **skipped:** 4.

### The 4 skipped tests – and what that means
They are the *concurrency* tests (two simultaneous refreshes with one token; two simultaneous admin transfers; concurrent duplicate subscribes; concurrent reactions by one user). They need MongoDB's guarantee that a single-document `findOneAndUpdate` is atomic. **The only database I could run in my sandbox was FerretDB (SQLite backend) because `fastdl.mongodb.org` is blocked; it does not provide that guarantee** (probe: 20 concurrent compare-and-set updates produced 1–3 "winners"). The suite probes this at start-up and *skips with a printed warning* rather than failing or silently passing. **The code uses the correct atomic operations, but I could not demonstrate them under concurrency on a real MongoDB.** Run `yarn test` against a real MongoDB to execute them.

## 2. The reported problems – each verified against the ZIP

| Reported issue | Verdict | Finding / fix |
|---|---|---|
| `POST /auth/login` returns 500 | **Reproduced as a hang; root cause found; fixed** | The cleanup worker ran `BLPOP 0` on the *same* Redis connection used by the rate limiter, blocking every later command (login/refresh hung; `logout`, which is not rate-limited, worked; the same login returned 200 in-process without the worker). A second path to a literal `INTERNAL_SERVER_ERROR`: the error handler had no Zod branch, so *any* invalid body (e.g. `username` instead of `identifier`) became a 500. Fixed: jobs moved to MongoDB (no blocking Redis calls); Zod/Cast/multer/JSON errors mapped to 4xx. I could not reproduce your exact environment, so I cannot rule out a third cause there, but the original request now returns 200 with the worker running. |
| Admin transfer without transactions | **Confirmed defective; redesigned** | Old code: two non-atomic writes with rollback that could itself fail, no DB constraint; pages were resolved through the *creator's* account id, so after a transfer the new admin got `PAGE_NOT_FOUND` for every admin action and editors could not list members. Now: one atomic compare-and-set on `Page.accountId` (single authoritative admin pointer), idempotent member-row reconciliation, partial unique index `one_admin_per_page`, `pageId`-based routes. |
| Default profile/page pictures missing | **Confirmed; fixed** | `assets/defaults/{profile,page}.png`, served at `/uploads/defaults/…`, used in every DTO. |
| Old images not deleted when replaced | **Confirmed for post images and page pictures; profile pictures already worked** | Fixed for page + post; tests assert the old file is gone from disk. |
| Account/page deletion left images | **Confirmed; fixed** | Handlers delete profile/page/post files. (A test caught a leak in my own first version – the profile row was deleted inline before the job could read the picture path – fixed.) |
| Cleanup handlers not fully wired | **Confirmed** | Account/page deletion ran inline or had no handler. Now `post`, `page`, `account` handlers exist, are wired, retried, and status-tracked (`pending/processing/completed/failed`). |
| Redis security | **Audited; no secrets found in Redis; hardening added** | Redis holds cache DTOs, OTP hash, rate-limit counters. OTP hash was an unkeyed SHA-256 (brute-forceable) → keyed HMAC. Cache health used global Redis stats → scoped counters. A test scans all Redis keys/values for hashes, tokens, e-mails. |
| Feed display information | **Confirmed; fixed** | Feed returned bare ids; now includes page and author display data (batched, never stale). |
| Separate reply-pagination endpoint | **Interpreted as required** | Added `GET /comments/:commentId/replies`; the post listing returns top-level comments with `replyCount`. |
| Unused imports / backup files | **Confirmed; removed** | 4 `.backup` files, committed `dist/`, duplicate `tests/setup.js`, misplaced `src/.env.example` + `src/.gitignore`, empty `src/routes/`, duplicate member logic in two services, dead exports. ESLint reports 0 problems. |

### Other defects found beyond your list
* **A real `.env` containing a Gmail app password was inside the ZIP.** It is not in the deliverable. **Please rotate that password.**
* All 97 original tests were fully mocked (no DB/Redis/HTTP); they could not detect the login bug. Replaced by 114 integration tests (the old suites tested internals that were rewritten; nothing was deleted without replacement coverage of the same features).
* Registration revealed whether an e-mail/username exists; login timing differed for unknown accounts; rate limiter trusted client `X-Forwarded-For` and was per-IP only (later also found too strict for shared IPs and corrected); 429 body used a different error shape.
* Refresh reuse did not revoke the chain; no sign-in chain / token hash; access tokens stayed valid after logout/password change.
* Comments/reactions inconsistent: only members could comment; deleting a parent comment orphaned its replies; invalid ids caused 500s; subscribe/react were check-then-insert (race → 500).
* Any editor could edit/delete any post; no `GET /post/:id`; no `DELETE /page`; uploads: errors were 500s, no `nosniff`/cache headers, orphan files on failed requests.
* `/internal/cache-health` and `/internal/cleanup/:id` were unauthenticated; `/health` had typos (`servises`, `"true "`); the server logged the Mongo URI.
* Seed used raw inserts with ObjectIds and was not idempotent.

## 3. Requirement table

| Requirement | Status | Evidence | Files Changed |
|---|---|---|---|
| 1 Page members (single Admin, add/remove editors, transfer, list, unique membership) | **PARTIAL** | `tests/pages.test.ts` (13 pass): one admin before/after transfer, new admin has full powers, old admin demoted, invalid transfers rejected, admin cannot be removed/leave, self-heal after simulated crash, DB unique index checked. **Why partial:** the concurrent-transfer test (`itAtomic`) was skipped (no atomic CAS in my DB stand-in) and the partial unique index `one_admin_per_page` could not be created on FerretDB (`partialFilterExpression` not implemented) – both unverified on real MongoDB. The authoritative single pointer + CAS is verified sequentially. | `modules/page/*`, `page-member.model.ts`, routes |
| 2 Subscriptions (idempotent, unique pageId+accountId, lists) | **PARTIAL** | `tests/subscriptions-feed.test.ts`: 201/200/200 with one row, idempotent unsubscribe, lists, admin-only subscribers, unique index asserted. **Why partial:** concurrent-duplicate test skipped (atomicity). Upsert + duplicate-key retry is implemented. | `modules/subscription/*` |
| 3 Feed (subscribed pages only, pagination in DB, stable) | **PASS** | Feed tests: only subscribed, empty ≠ recommendations, unsubscribe visible on the very next request even when cached, 23 posts incl. 10 identical timestamps paged without gap/dup, **Mongoose debug capture proves `skip/limit/sort` sent to MongoDB** (`limit:4,skip:2,sort:{createdAt:-1,_id:-1}`). | `modules/feed/*`, `post.repository.ts` |
| 4 Posts (CRUD, authz, cleanup) | **PASS** | `tests/content.test.ts` posts: create with images, validation, author-only edit, author/admin delete, old images deleted, no orphans on rejected upload, UUID ids, ISO-Z timestamps. | `modules/post/*` |
| 5 Comments (reply depth 1, own edit/delete, admin delete, DB pagination) | **PASS** | Depth rule, parent/post mismatch, edit author-only, admin deletes any, parent delete removes replies, 7 comments with identical timestamps paged stably, replies endpoint paginated, `replyCount` by one aggregation. | `modules/comment/*` |
| 6 Reactions (six types, one per user, counts, filter, pagination, unique) | **PARTIAL** | Six types accepted, invalid → 400, replace not add, remove idempotent, counts + `myReaction`, filter by type, paginated stable, unique index asserted. **Why partial:** concurrent same-user test skipped (atomicity); atomic upsert + 11000 retry implemented. | `modules/reaction/*` |
| 7 Deletion & cleanup (post/page/account, worker, job status, wired handlers) | **PASS** | `tests/cleanup.test.ts` (8): post/page/account deletion remove comments, replies, reactions, images, memberships, subscriptions, sessions, caches; handlers for all three types run; failed precondition retried then `failed` without data loss; crashed-worker lock recovery; status endpoint authz. Live run: 9/9 jobs `completed`. | `common/jobs/*`, `common/workers/*`, `auth.service.ts` |
| 8 Pagination (size/position, items, next-page info, DB-side, stable, max, validation, documented) | **PASS** | Default 20 / max 50 documented in README; invalid `size`/`position` → 400 (6 cases); DB-side proven (above). | `common/pagination/*`, all list endpoints |
| 9 Redis cache (read-through, prefix, TTL, invalidation, health, no secrets) | **PASS** | `tests/cache.test.ts` (9): miss→loader→hit, TTL>0, all keys prefixed, value injected into Redis is served then invalidated on write, post/page/transfer invalidation, outage degrades, `/health` exposes `hitRatio/keyCount/evictionCount`, full Redis scan finds no e-mail/hash/token. Live scan: 0 secrets. | `common/cache/*`, `app.ts` |
| 10 Upload security | **PASS** | `tests/uploads.test.ts` (15): real PNG/JPEG/GIF/WebP/BMP accepted by signature even with wrong extension; text-as-`.png`, SVG, wrong MIME → 415; >5 MB → 413; public serving with correct Content-Type, `nosniff`, `Cache-Control`; dotfile/traversal/non-image refused; defaults served; old profile/page pictures deleted; no N+1 (images embedded in docs). | `upload.middleware.ts`, `file-cleanup.ts`, `assets/` |
| 11 Account security (enumeration, rate limits, OTP) | **PARTIAL** | Auth tests: identical 401 for wrong password vs unknown user, e-mail-taken registration indistinguishable, 429 on register/login/verify/refresh (not bypassable by `X-Forwarded-For`, not blocking many accounts behind one IP), OTP: CSPRNG 6 digits, only HMAC in Redis, TTL ≤ 600 s, single-use, new code invalidates old, 5-attempt limit, never in responses. **Why partial:** real SMTP delivery was not exercised (`file`/`memory` transports verified); a taken *username* is still disclosed by design (public identifier). | `modules/auth/*`, `rate-limit.middleware.ts`, `email.service.ts` |
| 12 Sessions & refresh tokens | **PARTIAL** | Rotation, lineage, `tokenHash`, family reuse-revocation (other devices unaffected), logout/logout-all/password change take effect immediately for refresh **and** access tokens; 15 min / 7 d verified; no tokens in Redis. **Why partial:** concurrent-refresh race test skipped (atomic CAS unverifiable here); TTL index on `expiresAt` not implemented by FerretDB. | `token-ancestry.*`, `jwt.ts`, `auth.middleware.ts` |
| 13 Database constraints | **PARTIAL** | Unique username, e-mail, subscription, reaction, membership indexes asserted in tests; duplicate insert raises 11000. **Why partial:** the one-admin partial unique index and TTL indexes could not be built/verified on FerretDB; the server logs a warning instead of failing there. Exactly-one-admin is enforced by the single `Page.accountId` pointer (verified). No transactions used (works on standalone MongoDB); guarantees/limits documented in README. | models, `database.ts` |
| 14 IDs & timestamps | **PASS** | UUIDs for accounts/pages/posts/comments/jobs; ISO-8601 `Z` asserted; migration `002` converts old ObjectIds. (Migrations were not run against a legacy dataset – no such data was available.) | models, `migrations/002-*` |
| 15 Trace header | **PASS** | Echoed when safe, generated otherwise, present on success, 401, 404, malformed JSON, and unsafe client values (replaced). | `trace.middleware.ts`, `app.ts` order |
| 16 Seed | **PASS** | Required operator/e-mail/password/page id; 4 members, 56 subscribers (> max page size), 60 posts (ties in `createdAt`), 55 comments + replies on one post, 350 reactions; fresh run 14 s; second run completes with identical counts, 0 duplicate reactions, 1 admin row (an earlier version hung on a 178-op bulk write on re-run – fixed by batching and re-verified). | `src/seed.ts` |
| 17 Scripts | **PASS** | `dev`, `test`, `lint`, `seed` (+ `build`, `start`, `migrate`) present and run; `yarn.lock` present. | `package.json`, `eslint.config.mjs` |
| 18 Testing | **PASS** | 114 tests listed in §1 covering every item in the requirement, including authorization/security failures and edge cases (not only happy paths). | `tests/*` |
| 19 Build & lint | **PASS** | exit 0 / 0 warnings. | – |
| 20 README | **PASS** | All required sections incl. env vars, setup, auth/OTP/rotation, members, feed, uploads, pagination, cache, cleanup, security, assumptions, limitations, example requests. | `README.md` |
| 21 Postman | **PASS** | `postman/social-media-app.postman_collection.json` (11 required folders + error-case subfolders + SEED DEMO) and `…environment.json` (`baseUrl=http://localhost:8080`); tokens saved automatically; pagination examples; executed by newman: 0 failures. OTP step needs the code pasted from the e-mail (documented). | `postman/*` |
| 22 Route audit | **PASS** | Exact route table in README generated from the router files; auth applied via `router.use(authMiddleware)` / per-route; Zod validation on every input; all exercised by Postman run. **Breaking changes vs the original API are listed in §4.** | routers |
| 23 Error handling | **PASS** | One format; Zod/Cast/multer/JSON/duplicate-key mapped to 4xx; 500 hides details (stack only in `development`); server-side log tagged with trace ref; auth errors generic. | `error.middleware.ts` |
| 24 Code quality | **PASS** | Dead/duplicate code and backups removed, N+1 removed (`loadPeople`, reply counts), unhandled-promise risks removed (Express 5 + typed errors), ESLint clean. | repo-wide |
| 25 Final verification | **PARTIAL** | Steps 1–8 all executed (install, build, lint, test, seed, dev, Postman, Mongo/Redis inspection). **Why partial:** run on **FerretDB, not real MongoDB**, and without a real SMTP server (see §1, §5). | – |

## 4. Intentional API changes (needed to satisfy the requirements)
* Page endpoints are addressed by `pageId`: `/page/:pageId`, `/page/:pageId/members/…`. The old implicit "my page" routes (e.g. `/page/members`, `/page/editor`, `/page/me`) are removed – they could not work after an admin transfer. `GET /page/mine` lists my pages; `DELETE /page/:pageId` added.
* `POST /post` now takes `pageId`; added `GET /post/:postId`.
* Comment/reaction/post/page ids are UUIDs (run `yarn migrate` on old databases).
* Auth responses: `accessTokenExpiresIn`/`refreshTokenExpiresIn` added; `PATCH /auth/password` returns a new token pair; account/page/post deletion return `202` with `cleanupJobId`.
* Behaviour changes: editors can no longer edit/delete other people's posts; any authenticated user can comment/react; a user may administer several pages.

## 5. Remaining known limitations / what I could not verify
1. **Real MongoDB was not available** (sandbox blocks its download). Not verified there: the 4 concurrency tests, partial unique index `one_admin_per_page`, TTL indexes (sessions, completed jobs). Please run `yarn test` and `yarn dev` once against real MongoDB 6/7.
2. **Real SMTP delivery** not exercised.
3. Migrations `001/002` were written but not run against a legacy database.
4. Postman file uploads depend on Postman's working directory (`postman/fixtures/sample.png`).
5. Design limitations (documented in README): no e-mail verification at registration; case-sensitive usernames; offset pagination can shift under concurrent writes; rate limiting fails open if Redis is down; feed builds a `$in` filter from the caller's subscribed page ids; admin mirror rows may briefly lag after a crash mid-transfer (self-healing, authorisation unaffected); `EMAIL_TRANSPORT=file` writes OTPs to disk (development only).
6. **Rotate the Gmail app password that was committed in the ZIP's `.env`.**
