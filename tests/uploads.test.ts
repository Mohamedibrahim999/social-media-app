import fs from "fs";
import path from "path";
import {
  FAKE_IMAGE_BYTES, JPEG_BYTES, PNG_BYTES, api, createPage, createUser, resetState, setupInfrastructure,
  teardownInfrastructure, uploadedFilesOnDisk,
} from "./support/helpers";
import { MAX_IMAGE_BYTES } from "../src/common/middleware/upload.middleware";

beforeAll(setupInfrastructure);
afterAll(teardownInfrastructure);
beforeEach(resetState);

const GIF_BYTES = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]);
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(32)]);
const BMP_BYTES = Buffer.concat([Buffer.from("BM"), Buffer.alloc(40)]);

describe("upload validation", () => {
  it.each([
    ["PNG", PNG_BYTES, "image/png", ".png"],
    ["JPEG", JPEG_BYTES, "image/jpeg", ".jpg"],
    ["GIF", GIF_BYTES, "image/gif", ".gif"],
    ["WebP", WEBP_BYTES, "image/webp", ".webp"],
    ["BMP", BMP_BYTES, "image/bmp", ".bmp"],
  ])("accepts a real %s and stores it under the TRUE extension", async (_name, bytes, mime, extension) => {
    const user = await createUser("up");
    // deliberately wrong filename extension: content decides
    const res = await api().post("/profile/picture").set(user.auth).attach("image", bytes, { filename: "whatever.txt", contentType: mime });
    expect(res.status).toBe(200);
    expect(res.body.data.picture).toMatch(new RegExp(`^/uploads/profiles/[0-9a-f-]{36}\\${extension}$`));
  });

  it("rejects text/script content disguised as an image (png extension + image/png header)", async () => {
    const user = await createUser("up");
    const res = await api().post("/profile/picture").set(user.auth).attach("image", FAKE_IMAGE_BYTES, { filename: "evil.png", contentType: "image/png" });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("INVALID_IMAGE_TYPE");
    expect(uploadedFilesOnDisk("profiles")).toHaveLength(0);
  });

  it("rejects a real PNG sent with a non-image MIME header and an SVG/HTML payload", async () => {
    const user = await createUser("up");
    expect((await api().post("/profile/picture").set(user.auth).attach("image", PNG_BYTES, { filename: "a.png", contentType: "application/octet-stream" })).status).toBe(415);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await api().post("/profile/picture").set(user.auth).attach("image", svg, { filename: "a.svg", contentType: "image/svg+xml" })).status).toBe(415);
    expect(uploadedFilesOnDisk("profiles")).toHaveLength(0);
  });

  it("enforces the size limit with 413 and leaves nothing on disk", async () => {
    const user = await createUser("up");
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_IMAGE_BYTES + 1024)]);
    const res = await api().post("/profile/picture").set(user.auth).attach("image", big, { filename: "big.png", contentType: "image/png" });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
    expect(uploadedFilesOnDisk("profiles")).toHaveLength(0);
  });

  it("requires a file, authentication, and limits the number of post images", async () => {
    const user = await createUser("up");
    const page = await createPage(user);
    const none = await api().post("/profile/picture").set(user.auth);
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("PROFILE_PICTURE_REQUIRED");
    expect((await api().post("/profile/picture").attach("image", PNG_BYTES, "a.png")).status).toBe(401);
    let req = api().post("/post").set(user.auth).field("pageId", page.id).field("content", "many");
    for (let i = 0; i < 11; i++) req = req.attach("images", PNG_BYTES, { filename: `${i}.png`, contentType: "image/png" });
    expect((await req).status).toBe(400);
    expect(uploadedFilesOnDisk("posts")).toHaveLength(0);
  });
});

describe("serving images", () => {
  it("serves uploads publicly (no auth) with correct Content-Type, nosniff and cache headers", async () => {
    const user = await createUser("up");
    const res = await api().post("/profile/picture").set(user.auth).attach("image", PNG_BYTES, { filename: "a.png", contentType: "image/png" });
    const served = await api().get(res.body.data.picture); // note: no Authorization header
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["cache-control"]).toMatch(/public/);
    expect(served.headers["cache-control"]).toMatch(/max-age=31536000/);
    expect(Buffer.compare(served.body, PNG_BYTES)).toBe(0);
    expect(served.headers["etag"]).toBeDefined();
  });

  it("refuses non-image extensions, dotfiles and path traversal", async () => {
    fs.writeFileSync(path.join(process.cwd(), "uploads", "secret.txt"), "top secret");
    fs.writeFileSync(path.join(process.cwd(), "uploads", ".hidden.png"), "x");
    expect((await api().get("/uploads/secret.txt")).status).toBe(404);
    expect((await api().get("/uploads/.hidden.png")).status).toBe(404);
    const traversal = await api().get("/uploads/..%2f..%2fpackage.json");
    expect([403, 404]).toContain(traversal.status);
    expect((await api().get("/uploads/profiles/nope.png")).status).toBe(404);
  });
});

describe("default and replaced pictures", () => {
  it("new profiles and pages show working default pictures", async () => {
    const user = await createUser("def");
    const profile = await api().get("/profile/me").set(user.auth);
    expect(profile.body.data.picture).toBe("/uploads/defaults/profile.png");
    const page = await createPage(user);
    expect(page.picture).toBe("/uploads/defaults/page.png");
    for (const url of [profile.body.data.picture, page.picture]) {
      const res = await api().get(url);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("replacing a profile picture deletes the old file", async () => {
    const user = await createUser("rep");
    const first = await api().post("/profile/picture").set(user.auth).attach("image", PNG_BYTES, { filename: "a.png", contentType: "image/png" });
    const second = await api().post("/profile/picture").set(user.auth).attach("image", JPEG_BYTES, { filename: "b.jpg", contentType: "image/jpeg" });
    expect(second.status).toBe(200);
    expect(uploadedFilesOnDisk("profiles")).toEqual([second.body.data.picture.split("/").pop()]);
    expect((await api().get(first.body.data.picture)).status).toBe(404);
    expect((await api().get(second.body.data.picture)).status).toBe(200);
  });

  it("replacing a page picture deletes the old file; non-admins cannot change it and leave no file behind", async () => {
    const admin = await createUser("adm");
    const other = await createUser("oth");
    const page = await createPage(admin);
    const denied = await api().post(`/page/${page.id}/picture`).set(other.auth).attach("image", PNG_BYTES, { filename: "a.png", contentType: "image/png" });
    expect(denied.status).toBe(403);
    expect(uploadedFilesOnDisk("pages")).toHaveLength(0);
    const first = await api().post(`/page/${page.id}/picture`).set(admin.auth).attach("image", PNG_BYTES, { filename: "a.png", contentType: "image/png" });
    const second = await api().post(`/page/${page.id}/picture`).set(admin.auth).attach("image", JPEG_BYTES, { filename: "b.jpg", contentType: "image/jpeg" });
    expect(second.body.data.picture).not.toBe(first.body.data.picture);
    expect(uploadedFilesOnDisk("pages")).toHaveLength(1);
    expect((await api().get(first.body.data.picture)).status).toBe(404);
  });

  it("the shipped default pictures are never deleted by cleanup", async () => {
    const { deleteUploadedFile } = await import("../src/common/utils/file-cleanup");
    await deleteUploadedFile("/uploads/defaults/profile.png");
    expect((await api().get("/uploads/defaults/profile.png")).status).toBe(200);
  });
});
