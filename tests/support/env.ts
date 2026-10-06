import fs from "fs";
import os from "os";
import path from "path";

// Runs before every test file, before any application module is imported.
process.env.NODE_ENV = "test";
process.env.PORT = "8081"; // never bound: tests use supertest against the app object
process.env.TRUST_PROXY = "0";
process.env.MONGO_URI = process.env.MONGO_TEST_URI ?? "mongodb://127.0.0.1:27017/tapi_test";
process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/15"; // dedicated Redis DB, flushed between tests
process.env.JWT_ACCESS_SECRET = "test-access-secret-0123456789abcdef";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-fedcba9876543210";
process.env.CACHE_EPOCH_PREFIX = "tapi:test";
process.env.EMAIL_TRANSPORT = "memory";

// Uploads are written relative to process.cwd(): run inside a throw-away directory so tests never touch ./uploads.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tapi-tests-"));
fs.symlinkSync(path.join(__dirname, "..", "..", "assets"), path.join(sandbox, "assets"));
process.chdir(sandbox);
