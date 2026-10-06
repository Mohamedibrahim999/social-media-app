# Tapi – Social Media API

Node.js + TypeScript backend for a page-based social network: accounts, pages with an Admin/Editors team, subscriptions, a subscription-only feed, posts with images, threaded comments, six-type reactions, a Redis read-through cache, public image serving and a background cleanup system.

* [Quick start](#quick-start) · [Environment](#environment-variables) · [Architecture](#architecture) · [Authentication](#authentication-flow) · [Pages & members](#pages-and-members) · [API reference](#api-reference) · [Pagination](#pagination) · [Redis cache](#redis-cache) · [Cleanup](#cleanup-worker) · [Security](#security-decisions) · [Limitations](#known-limitations)
* Postman: `postman/social-media-app.postman_collection.json` + `postman/social-media-app.postman_environment.json`
* Verification evidence: `AUDIT_REPORT.md`

## Technologies

Node.js ≥ 20, TypeScript, Express 5, MongoDB (Mongoose 8), Redis (node-redis 6), JWT (HS256), bcrypt, Zod, Multer, Nodemailer, Jest + Supertest, ESLint (typescript-eslint), Yarn 1.

## Quick start

```bash
# prerequisites: Node 20+, Yarn 1, MongoDB on 27017, Redis on 6379
cp .env.example .env          # then edit secrets (openssl rand -hex 48)
yarn install
yarn seed                     # demo data (idempotent – safe to re-run)
yarn dev                      # http://localhost:8080
```

| Command | What it does |
|---|---|
| `yarn dev` | start with ts-node-dev (reload) |
| `yarn build` / `yarn start` | compile to `dist/` / run compiled build |
| `yarn lint` | ESLint (0 errors, 0 warnings) |
| `yarn test` | Jest **integration** tests (real MongoDB + Redis, HTTP via Supertest) |
| `yarn seed` | create the seed operator, page, members, subscribers, posts, comments, reactions |
| `yarn migrate` | one-off migrations for databases created by older versions (see below) |

### MongoDB setup
Any MongoDB 6/7 works. A **standalone** instance is fully supported (no transactions are used – see *Admin transfer*). Example: `docker run -d -p 27017:27017 mongo:7`. Indexes (unique username/email/membership/subscription/reaction, TTLs, one-admin-per-page) are built at startup (`ensureIndexes`) and by `yarn seed`.

### Redis setup
Any Redis ≥ 6. Example: `docker run -d -p 6379:6379 redis:7`. Redis holds: the read-through cache, OTP **hashes**, rate-limit counters. It never holds password hashes or tokens.

### Running the tests
`yarn test` needs MongoDB and Redis running. Tests use the database `tapi_test` and **Redis DB 15** (flushed between tests) – override with `MONGO_TEST_URI` / `REDIS_TEST_URL`. Uploads are written to a throw-away temp directory. The 4 concurrency tests (concurrent refresh / transfer / subscribe / react) require MongoDB's single-document atomicity; a start-up probe skips them with a warning on stand-ins that do not provide it (e.g. FerretDB's SQLite backend).

### Existing databases
`yarn migrate` runs `001` (page ids → UUID) and `002` (posts/comments ObjectId → UUID, aligns `Page.accountId` with the admin membership). Back up first. Sessions issued by older versions are invalid (they lack a token hash) – users simply sign in again.

## Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PORT` | no | `8080` | HTTP port |
| `NODE_ENV` | no | `development` | `production` hides all internals; stack traces are only ever returned in `development` |
| `TRUST_PROXY` | no | `0` | number of reverse proxies in front of the API (controls `req.ip` used by rate limits) |
| `MONGO_URI` | **yes** | – | MongoDB connection string (never logged) |
| `REDIS_URL` | **yes** | – | Redis connection string |
| `JWT_ACCESS_SECRET` | **yes** | – | ≥ 16 chars, must differ from the refresh secret |
| `JWT_REFRESH_SECRET` | **yes** | – | ≥ 16 chars (also keys the OTP HMAC) |
| `CACHE_EPOCH_PREFIX` | **yes** | – | prefix of every cache key; change it to invalidate the whole cache |
| `EMAIL_TRANSPORT` | no | `smtp` | `smtp` (real mail), `file` (dev: writes `.mail-outbox/*.json`), `memory` (tests) |
| `EMAIL_USER`, `EMAIL_PASSWORD` | only for `smtp` | – | Gmail account / app password |

The server refuses to start (with a readable list) if the configuration is invalid. `.env` is git-ignored; **never commit it**.

## Architecture

```
src/
  app.ts, server.ts            Express app (trace → json → routes → 404 → error handler); bootstrap + graceful shutdown
  config/                      env (Zod), database (connect, ensureIndexes), redis
  common/
    cache/                     Redis read-through cache, versioned invalidation, health stats
    constants/defaults.ts      default profile / page picture URLs
    errors/AppError.ts         typed HTTP errors
    jobs/                      cleanup job model, queue (claim/retry), handlers (post/page/account), status route
    middleware/                auth (JWT + live session check), rate-limit, trace, upload (+ public /uploads router), error
    pagination/                size/position validation + page-info
    services/email.service.ts  smtp | file | memory transports
    utils/                     jwt, file-cleanup, people (batched author/user lookup, no N+1)
    workers/cleanup.worker.ts  polls the Mongo-backed job queue
  modules/
    auth/ profile/ page/ (pages + members) subscription/ feed/ post/ comment/ reaction/
      *.model.ts  *.repository.ts  *.service.ts  *.controller.ts  *.routes.ts  *.schema.ts (Zod)
  migrations/  seed.ts
assets/defaults/               default profile.png / page.png (served at /uploads/defaults/…)
postman/                       collection, environment, fixtures
tests/                         integration tests + support/ (env, helpers, atomicity probe)
```

Layering: routes → controller (Zod parsing, HTTP) → service (rules, authorisation) → repository (Mongoose). Express 5 forwards rejected promises, so controllers have no try/catch; every error ends in one handler.

### IDs and timestamps
Accounts, pages, posts, comments and cleanup jobs use random **UUIDs**; no sequential integers are exposed. All timestamps are stored as UTC `Date`s and serialised as ISO-8601 with `Z` (timezone-aware).

## Authentication flow

* **Register** `POST /auth/register` – username (3-30, `[A-Za-z0-9_.-]`), e-mail, password (8-72). *Enumeration protection:* a taken **username** → `409 USERNAME_TAKEN` (usernames are public via `/profile/:username`); a taken **e-mail** is not revealed – the response is a normal-looking `201` and no account is created. Work (bcrypt) is identical either way.
* **Login with username** `POST /auth/login {"identifier":"alice","password":"…"}` → tokens immediately.
* **Login with e-mail** → password is checked, then a one-time code is e-mailed and `{"requiresVerification":true,"externalId":"<uuid>"}` is returned. Unknown account and wrong password are indistinguishable (`401 INVALID_CREDENTIALS`, same time cost via a dummy bcrypt compare).
* **Verify OTP** `POST /auth/login/verify {"externalId":"…","code":"123456"}`.

### OTP flow
6 digits from `crypto.randomInt` · stored in Redis **only as HMAC-SHA256(account id : code)** keyed with a server secret (a bare hash of 10⁶ values would be reversible) · TTL **10 minutes** · single use (atomic `DEL`) · issuing a new code replaces the old one · max **5** attempts per code (atomic `INCR`), then the code is burned · never in an API response or log · e-mail delivery failure → `503 EMAIL_DELIVERY_FAILED` and the code is discarded.

### Sessions and refresh-token rotation
Every login starts a **sign-in chain** (`familyId`). Each refresh token is a JWT (`jti`) whose SHA-256 is stored in MongoDB (`token_ancestry`): `tokenHash`, `familyId`, `parentTokenId`, `replacedByTokenId`, `status` (`active|superseded|revoked`), `expiresAt` (TTL index), `revokedAt/Reason`. Access token = **15 min**, refresh token = **7 days**; refresh tokens are never stored in Redis.

* `POST /auth/refresh` creates a new pair and atomically flips the old record `active → superseded` (compare-and-set). Presenting a **superseded** token again (replay/theft, or a lost race) revokes the **entire chain** (`401 REFRESH_TOKEN_REUSED`) – the attacker's and the victim's tokens both die.
* The auth middleware also checks that the access token's chain is still active, so **logout, logout-all, password change and reuse detection take effect immediately**, not after 15 minutes.
* `POST /auth/logout` (this device's chain), `POST /auth/logout-all` (all devices), `PATCH /auth/password` (revokes all sessions; returns a fresh pair for the current device).

```http
POST /auth/login          {"identifier":"seed_operator","password":"SeedOperator123!"}
200 {"message":"Login successful","data":{"requiresVerification":false,"accessToken":"…","refreshToken":"…","accessTokenExpiresIn":900,"refreshTokenExpiresIn":604800}}
```

## Pages and members

* A page has exactly **one Admin** for its whole life. `Page.accountId` is the **authoritative admin pointer** – a single field cannot hold two values. Membership rows (`pagemembers`, unique `pageId+accountId`) hold the editors and a mirror of the admin role; a partial unique index (`one_admin_per_page`) allows at most one `role:"admin"` row per page.
* Admin: add / remove editors, transfer the role to an **existing editor**, update/delete the page, change its picture, list subscribers. Editors: publish posts, list members, leave. The admin cannot be removed and cannot leave.
* **Admin transfer without transactions** (works on standalone MongoDB): (1) one atomic `findOneAndUpdate({_id, accountId: currentAdmin}, {accountId: target})` – the linearisation point; concurrent transfers cannot both match; (2) membership rows are re-synchronised idempotently (demote old, then upsert new). A crash between (1) and (2) is harmless – authorisation reads the pointer and `reconcileAdminRows` repairs the rows on the next member listing/transfer. Guarantee: exactly one admin before and after every transfer. Limitation: the mirror rows can lag for a moment after a crash (self-healing); on MongoDB replica sets this could be wrapped in a transaction but is not required.
* A user may belong to / administer several pages.

## API reference

All endpoints return JSON `{"message", "data"}`; errors return `{"error":{"code","message","details?","traceRef"}}`. Protected routes need `Authorization: Bearer <accessToken>`. Every response (success and error) carries `X-Tapi-Trace-Ref` (client value echoed if it matches `[A-Za-z0-9._:\-/]{1,128}`, otherwise generated).

| Method & path | Auth | Notes |
|---|---|---|
| `POST /auth/register` | – | rate-limited (10/15 min/IP) |
| `POST /auth/login` | – | rate-limited (10/15 min per identifier, 100 per IP) |
| `POST /auth/login/verify` | – | rate-limited (10 per account, 60 per IP) |
| `POST /auth/refresh` | – | rate-limited (60/15 min/IP) |
| `POST /auth/logout`, `POST /auth/logout-all` | refresh token in body | |
| `PATCH /auth/password`, `/auth/username`, `/auth/email` | ✔ | |
| `DELETE /auth/account` | ✔ | `202`, background cleanup |
| `GET /profile/me`, `PATCH /profile`, `POST /profile` | ✔ | |
| `GET /profile/:username` | – | public profile |
| `POST /profile/picture` | ✔ | multipart field `image` |
| `POST /page` · `GET /page/mine` · `GET/PATCH/DELETE /page/:pageId` | ✔ | update/delete: admin only; delete → `202` |
| `POST /page/:pageId/picture` | ✔ admin | multipart field `image` |
| `GET /page/:pageId/members` | ✔ member | paginated |
| `POST /page/:pageId/members/editors` | ✔ admin | body `{username}` |
| `DELETE /page/:pageId/members/editors/:username` | ✔ admin | |
| `PATCH /page/:pageId/members/admin` | ✔ admin | body `{username}` (transfer) |
| `DELETE /page/:pageId/members/me` | ✔ editor | leave |
| `POST /subscriptions` · `DELETE /subscriptions/:pageId` (or body `{pageId}`) | ✔ | idempotent |
| `GET /subscriptions/mine` | ✔ | paginated |
| `GET /subscriptions/page/:pageId/subscribers` | ✔ admin | paginated |
| `GET /feed` | ✔ | paginated |
| `POST /post` (multipart `pageId`, `content`, `images[]`) | ✔ member | |
| `GET /post/:postId` · `GET /post/page/:pageId` · `GET /post/me` | ✔ | lists paginated |
| `PATCH /post/:postId` (multipart `content`, `images[]`, `removeImages`) | ✔ author | |
| `DELETE /post/:postId` | ✔ author or page admin | `202` |
| `POST /comments/post/:postId` (body `content`, optional `parentCommentId`) | ✔ | any user |
| `GET /comments/post/:postId` · `GET /comments/:commentId/replies` | ✔ | paginated |
| `PATCH /comments/:commentId` | ✔ author | |
| `DELETE /comments/:commentId` | ✔ author or page admin | removes replies |
| `POST /reactions/post/:postId` (body `{type}`) · `DELETE …` | ✔ | any user |
| `GET /reactions/post/:postId?type=` | ✔ | counts + myReaction + paginated users |
| `GET /internal/cleanup/:jobId` | ✔ requester | job status |
| `GET /health` | – | status + cache stats |
| `GET /uploads/...` | – | public images |

### Posts
Members publish; **only the author edits** (and must still be a member); the **author or the page admin deletes**. Replacing images deletes the old files; a rejected request leaves no file on disk. Posts: `{id, pageId, author{accountId,username,displayName,picture}, content, images[], createdAt, updatedAt}`.

### Subscriptions & feed
`POST /subscriptions` is an atomic upsert on `unique(pageId, accountId)` (`201` first time, `200` afterwards); unsubscribing when not subscribed is a harmless `200`. The feed contains **only** posts of subscribed pages (no recommendations/trending/sampling), newest first, with page and author display data resolved in two batched queries. Unsubscribing removes the page from the very next request.

### Comments
Any authenticated user may comment on an existing post. Maximum reply depth is **1**. `GET /comments/post/:id` lists top-level comments (oldest first) with `replyCount` (one aggregation for the whole page); `GET /comments/:id/replies` pages through replies. Deleting a comment deletes its replies; the page admin may delete any comment of the page.

### Reactions
`like, love, haha, wow, sad, angry`. One per user per post (`unique(postId, accountId)`, atomic upsert); changing replaces; `DELETE` is idempotent. `GET` returns `counts` (all six + total), `myReaction`, and a paginated user list filterable with `?type=`.

```http
POST /reactions/post/<postId>  {"type":"love"}
200 {"data":{"counts":{"like":0,"love":1,"haha":0,"wow":0,"sad":0,"angry":0,"total":1},"myReaction":"love"}}
```

### Uploads
JPEG, PNG, GIF, WebP, BMP · max **5 MB** per image · max 10 images per post. The **file signature (magic bytes)** decides the type – the extension and `Content-Type` header are ignored (a text file named `.png` → `415 INVALID_IMAGE_TYPE`; too large → `413 FILE_TOO_LARGE`). Files get random UUID names with the true extension. `GET /uploads/...` is public, sends the correct `Content-Type`, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=31536000, immutable` (names are never reused), and refuses dotfiles, traversal and non-image extensions. Defaults: `/uploads/defaults/profile.png`, `/uploads/defaults/page.png`. Replacing a profile/page picture or post images deletes the old file; deleting an account/page/post deletes all its files. Images are stored as paths inside their owner document – no per-image queries.

## Pagination

Every list endpoint accepts `?size=` (1–**50**, default **20**) and `?position=` (zero-based offset, default 0). Invalid values (`size=0`, `51`, `abc`, `position=-1`) → `400 VALIDATION_ERROR`.

```json
{"data":{"items":[…],"pageInfo":{"size":20,"position":0,"hasNextPage":true,"nextPosition":20}}}
```
`skip/limit/sort` run **inside MongoDB** (`size+1` rows are fetched to compute `hasNextPage`); the sort always ends with the unique `_id`, so the order is total and stable even when many rows share a timestamp. Offset pagination can skip/repeat items if rows are inserted between requests – a known trade-off of the required `position` parameter.

## Redis cache

Read-through: Redis → (miss) MongoDB → `SET key EX ttl`; write: MongoDB write → delete/bump. All keys start with `CACHE_EPOCH_PREFIX`, TTL 300 s (feed 120 s). Cached: page by id, post by id, page/my post lists (rows only). The **feed** key embeds the subscribed page set and each page's post-version (`ver:page-posts:<id>`): any post change or (un)subscribe makes the old entry unreachable in O(1), and display data (page name, author name/picture) is joined fresh, so nothing important is stale. A Redis outage degrades to "always miss". `/health` returns `cache.hitRatio`, `hits`, `misses`, `keyCount` (cache keys only) and `evictionCount` (`INFO stats`).

Redis audit: besides the cache it holds `auth:login:otp:*` (HMAC only), `auth:login:otp:attempts:*` and `ratelimit:*` counters. No password hashes, refresh/access tokens, OTPs in clear or e-mail addresses (asserted by tests).

## Cleanup worker

Deleting a post, page or account removes the primary document immediately and enqueues a job in MongoDB (`cleanup_jobs`: `pending → processing → completed | failed`, attempts, error, timestamps). The job is created **before** the delete (outbox) and the handler first checks the target is really gone, so a failed delete can never cause data loss. Workers claim jobs atomically, retry with back-off (5 attempts), and re-claim jobs whose lock expired (crash recovery). Handlers:

* **post** – comments, replies, reactions, image files, post/list caches, feed versions
* **page** – all posts (and their dependents), memberships, subscriptions, page picture, caches
* **account** – administered pages (with content), authored posts, comments (and replies under them), reactions, subscriptions, memberships, profile + picture, sessions, OTP keys, caches

Status: `GET /internal/cleanup/:jobId` (requester only). The worker starts with the server (`startCleanupWorker`, 1 s poll) and never blocks Redis.

## Error handling

One format everywhere: `{"error":{"code","message","details?","traceRef"}}`. Zod → `400 VALIDATION_ERROR` with per-field details; malformed JSON → `400`; malformed id → `400`; upload errors → `400/413/415`; duplicate key → `409`; unknown routes → `404`; anything unexpected → `500 INTERNAL_SERVER_ERROR` with the details only in the server log (tagged with the trace ref). Stack traces are returned **only** when `NODE_ENV=development`.

## Security decisions

* bcrypt (cost 12); constant-work login/registration; generic credential errors; per-account and per-IP rate limits using `req.ip` (never a client-supplied `X-Forwarded-For`).
* Short-lived access tokens with a **live session check**; hashed, rotating, family-tracked refresh tokens with reuse detection.
* OTP keyed-HMAC, one-time, attempt-limited, 10 min.
* Upload signature sniffing, size limits, random names, `nosniff`, no SVG/HTML ever served.
* Strict Zod validation on every input; malformed ids can never reach the database as casts.
* The `.env` file with credentials is not shipped; `MONGO_URI` is never logged; `x-powered-by` disabled.

## Assumptions

* Posts are public content: any authenticated user can read, comment and react (a subscriber is exactly who sees a post in the feed). Only members publish.
* Post edit = author only; post delete = author or admin (moderation).
* A user can be admin/editor of many pages. `DELETE /auth/account` deletes the pages the user administers.
* A taken e-mail at registration is not disclosed (see above); the user can use *login* to recover.

## Known limitations

* No e-mail verification at registration; registration of an already-used e-mail silently does not create an account.
* Usernames are case-sensitive (`Alice` and `alice` can coexist).
* Offset (`position`) pagination can shift under concurrent writes; very deep offsets are slower.
* Rate-limit state is in Redis and fails **open** if Redis is down (logged).
* Feed loads the caller's subscribed page ids to build the `$in` filter (fine for thousands, not millions of subscriptions).
* The admin mirror rows may lag after a crash mid-transfer until the next reconciliation (authorisation is unaffected).
* The dev-only `EMAIL_TRANSPORT=file` writes OTPs to disk – never use it in production.
* Image content is validated by signature, not re-encoded; no virus scanning.
