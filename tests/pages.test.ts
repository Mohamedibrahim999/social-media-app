import {
  api, createPage, createUser, drainCleanup, itAtomic, resetState, setupInfrastructure, teardownInfrastructure,
} from "./support/helpers";
import { PageMemberModel } from "../src/modules/page/page-member.model";
import { PageModel } from "../src/modules/page/page.model";

beforeAll(setupInfrastructure);
afterAll(teardownInfrastructure);
beforeEach(resetState);

const addEditor = (admin: { auth: { Authorization: string } }, pageId: string, username: string) =>
  api().post(`/page/${pageId}/members/editors`).set(admin.auth).send({ username });
const members = (user: { auth: { Authorization: string } }, pageId: string, query = "") =>
  api().get(`/page/${pageId}/members${query}`).set(user.auth);

describe("page lifecycle", () => {
  it("creates a page whose creator is its single admin, with the default picture", async () => {
    const admin = await createUser("adm");
    const page = await createPage(admin);
    expect(page.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.adminAccountId).toBe(admin.accountId);
    expect(page.picture).toBe("/uploads/defaults/page.png");
    const list = await members(admin, page.id);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({ accountId: admin.accountId, role: "admin" });
  });

  it("validates input and requires authentication", async () => {
    const admin = await createUser("adm");
    expect((await api().post("/page").set(admin.auth).send({ name: "" })).status).toBe(400);
    expect((await api().post("/page").send({ name: "x" })).status).toBe(401);
    expect((await api().get("/page/not-a-uuid").set(admin.auth)).status).toBe(400);
    expect((await api().get("/page/00000000-0000-4000-8000-000000000000").set(admin.auth)).status).toBe(404);
  });

  it("only the admin can update the page; reads reflect the update immediately (cache invalidated)", async () => {
    const admin = await createUser("adm");
    const outsider = await createUser("out");
    const page = await createPage(admin);
    expect((await api().get(`/page/${page.id}`).set(outsider.auth)).body.data.name).toBe("Test Page"); // warms the cache
    expect((await api().patch(`/page/${page.id}`).set(outsider.auth).send({ name: "Hacked" })).status).toBe(403);
    const res = await api().patch(`/page/${page.id}`).set(admin.auth).send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect((await api().get(`/page/${page.id}`).set(outsider.auth)).body.data.name).toBe("Renamed");
    expect((await api().patch(`/page/${page.id}`).set(admin.auth).send({})).status).toBe(400);
  });

  it("lists the pages I belong to (with my role)", async () => {
    const admin = await createUser("adm");
    const editor = await createUser("ed");
    const page = await createPage(admin);
    await addEditor(admin, page.id, editor.username);
    const res = await api().get("/page/mine").set(editor.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([expect.objectContaining({ id: page.id, role: "editor" })]);
  });

  it("deleting a page is admin-only, immediate for the page, and queues a tracked cleanup job", async () => {
    const admin = await createUser("adm");
    const other = await createUser("oth");
    const page = await createPage(admin);
    expect((await api().delete(`/page/${page.id}`).set(other.auth)).status).toBe(403);
    const res = await api().delete(`/page/${page.id}`).set(admin.auth);
    expect(res.status).toBe(202);
    expect((await api().get(`/page/${page.id}`).set(admin.auth)).status).toBe(404);
    const job = await api().get(`/internal/cleanup/${res.body.data.cleanupJobId}`).set(admin.auth);
    expect(["pending", "processing", "completed"]).toContain(job.body.data.status);
    await drainCleanup();
    expect((await api().get(`/internal/cleanup/${res.body.data.cleanupJobId}`).set(admin.auth)).body.data.status).toBe("completed");
    expect(await PageMemberModel.countDocuments({ pageId: page.id })).toBe(0);
  });
});

describe("members", () => {
  it("admin adds editors; duplicates are rejected; non-admins cannot add", async () => {
    const admin = await createUser("adm");
    const editor = await createUser("ed");
    const stranger = await createUser("str");
    const page = await createPage(admin);

    const added = await addEditor(admin, page.id, editor.username);
    expect(added.status).toBe(201);
    expect(added.body.data.role).toBe("editor");
    expect((await addEditor(admin, page.id, editor.username)).status).toBe(409); // unique(pageId, accountId)
    expect((await addEditor(admin, page.id, admin.username)).status).toBe(409);
    expect((await addEditor(editor, page.id, stranger.username)).status).toBe(403);
    expect((await addEditor(stranger, page.id, stranger.username)).status).toBe(403);
    expect((await addEditor(admin, page.id, "no_such_user")).status).toBe(404);
    expect(await PageMemberModel.countDocuments({ pageId: page.id, accountId: editor.accountId })).toBe(1);
  });

  it("only members can list members; listing shows exactly one admin", async () => {
    const admin = await createUser("adm");
    const editor = await createUser("ed");
    const stranger = await createUser("str");
    const page = await createPage(admin);
    await addEditor(admin, page.id, editor.username);
    expect((await members(stranger, page.id)).status).toBe(403);
    const asEditor = await members(editor, page.id);
    expect(asEditor.status).toBe(200);
    const roles = asEditor.body.data.items.map((m: { role: string }) => m.role).sort();
    expect(roles).toEqual(["admin", "editor"]);
    expect(asEditor.body.data.items[0].email).toBeUndefined();
  });

  it("removes editors; the admin can never be removed; unknown members give 404", async () => {
    const admin = await createUser("adm");
    const editor = await createUser("ed");
    const page = await createPage(admin);
    await addEditor(admin, page.id, editor.username);
    expect((await api().delete(`/page/${page.id}/members/editors/${editor.username}`).set(editor.auth)).status).toBe(403);
    const removeAdmin = await api().delete(`/page/${page.id}/members/editors/${admin.username}`).set(admin.auth);
    expect(removeAdmin.status).toBe(400);
    expect(removeAdmin.body.error.code).toBe("CANNOT_REMOVE_ADMIN");
    expect((await api().delete(`/page/${page.id}/members/editors/${editor.username}`).set(admin.auth)).status).toBe(200);
    expect((await api().delete(`/page/${page.id}/members/editors/${editor.username}`).set(admin.auth)).status).toBe(404);
    expect((await members(editor, page.id)).status).toBe(403);
  });

  it("an editor may leave; the admin may not", async () => {
    const admin = await createUser("adm");
    const editor = await createUser("ed");
    const page = await createPage(admin);
    await addEditor(admin, page.id, editor.username);
    const adminLeave = await api().delete(`/page/${page.id}/members/me`).set(admin.auth);
    expect(adminLeave.status).toBe(409);
    expect(adminLeave.body.error.code).toBe("ADMIN_CANNOT_LEAVE");
    expect((await api().delete(`/page/${page.id}/members/me`).set(editor.auth)).status).toBe(200);
    expect((await api().delete(`/page/${page.id}/members/me`).set(editor.auth)).status).toBe(404);
  });

  it("paginates members with size/position and stable ordering", async () => {
    const admin = await createUser("adm");
    const page = await createPage(admin);
    for (let i = 0; i < 5; i++) await addEditor(admin, page.id, (await createUser("e")).username);
    const first = await members(admin, page.id, "?size=2&position=0");
    const second = await members(admin, page.id, "?size=2&position=2");
    const third = await members(admin, page.id, "?size=2&position=4");
    expect(first.body.data.pageInfo).toEqual({ size: 2, position: 0, hasNextPage: true, nextPosition: 2 });
    expect(third.body.data.pageInfo).toEqual({ size: 2, position: 4, hasNextPage: false, nextPosition: null });
    const ids = [first, second, third].flatMap((r) => r.body.data.items.map((m: { accountId: string }) => m.accountId));
    expect(new Set(ids).size).toBe(6);
    const again = await members(admin, page.id, "?size=2&position=2");
    expect(again.body.data.items).toEqual(second.body.data.items); // stable
  });
});

describe("admin transfer", () => {
  const transfer = (admin: { auth: { Authorization: string } }, pageId: string, username: string) =>
    api().patch(`/page/${pageId}/members/admin`).set(admin.auth).send({ username });

  it("moves the admin role to an editor: exactly one admin before and after, new admin has full powers", async () => {
    const oldAdmin = await createUser("old");
    const newAdmin = await createUser("new");
    const third = await createUser("third");
    const page = await createPage(oldAdmin);
    await addEditor(oldAdmin, page.id, newAdmin.username);

    const res = await transfer(oldAdmin, page.id, newAdmin.username);
    expect(res.status).toBe(200);
    expect(res.body.data.newAdminAccountId).toBe(newAdmin.accountId);

    const list = await members(newAdmin, page.id);
    expect(list.body.data.items.filter((m: { role: string }) => m.role === "admin")).toHaveLength(1);
    expect(list.body.data.items.find((m: { role: string }) => m.role === "admin").accountId).toBe(newAdmin.accountId);
    expect(await PageMemberModel.countDocuments({ pageId: page.id, role: "admin" })).toBe(1);
    expect((await PageModel.findById(page.id))!.accountId).toBe(newAdmin.accountId);

    // the NEW admin can use every admin operation (regression: used to return PAGE_NOT_FOUND)
    expect((await addEditor(newAdmin, page.id, third.username)).status).toBe(201);
    expect((await api().patch(`/page/${page.id}`).set(newAdmin.auth).send({ name: "Mine now" })).status).toBe(200);
    // the OLD admin is now a plain editor
    expect((await addEditor(oldAdmin, page.id, third.username)).status).toBe(403);
    expect((await api().patch(`/page/${page.id}`).set(oldAdmin.auth).send({ name: "x" })).status).toBe(403);
    expect((await members(oldAdmin, page.id)).status).toBe(200);
    // and may now leave, while the new admin may not
    expect((await api().delete(`/page/${page.id}/members/me`).set(newAdmin.auth)).status).toBe(409);
    expect((await api().delete(`/page/${page.id}/members/me`).set(oldAdmin.auth)).status).toBe(200);
  });

  it("rejects invalid transfers", async () => {
    const admin = await createUser("adm");
    const editor = await createUser("ed");
    const stranger = await createUser("str");
    const page = await createPage(admin);
    await addEditor(admin, page.id, editor.username);

    const toSelf = await transfer(admin, page.id, admin.username);
    expect(toSelf.status).toBe(400);
    expect(toSelf.body.error.code).toBe("CANNOT_TRANSFER_TO_SELF");
    const toNonMember = await transfer(admin, page.id, stranger.username);
    expect(toNonMember.status).toBe(400);
    expect(toNonMember.body.error.code).toBe("TARGET_NOT_EDITOR");
    expect((await transfer(admin, page.id, "ghost_user")).status).toBe(404);
    expect((await transfer(editor, page.id, editor.username)).status).toBe(403); // an editor cannot promote himself
    expect((await transfer(stranger, page.id, stranger.username)).status).toBe(403);
    expect((await api().patch(`/page/${page.id}/members/admin`).set(admin.auth).send({})).status).toBe(400);
    expect((await PageModel.findById(page.id))!.accountId).toBe(admin.accountId); // nothing changed
  });

  it("self-heals when the membership rows lag behind the authoritative admin pointer (crash between steps)", async () => {
    const oldAdmin = await createUser("old");
    const newAdmin = await createUser("new");
    const page = await createPage(oldAdmin);
    await addEditor(oldAdmin, page.id, newAdmin.username);
    await PageModel.updateOne({ _id: page.id }, { $set: { accountId: newAdmin.accountId } }); // step 1 done, step 2 "crashed"

    const list = await members(newAdmin, page.id); // new admin is recognised even before reconciliation
    expect(list.status).toBe(200);
    const admins = list.body.data.items.filter((m: { role: string }) => m.role === "admin");
    expect(admins).toHaveLength(1);
    expect(admins[0].accountId).toBe(newAdmin.accountId);
    expect(await PageMemberModel.countDocuments({ pageId: page.id, role: "admin" })).toBe(1);
  });

  itAtomic("two simultaneous transfers: exactly one succeeds and the page keeps exactly one admin", async () => {
    const admin = await createUser("adm");
    const a = await createUser("a");
    const b = await createUser("b");
    const page = await createPage(admin);
    await addEditor(admin, page.id, a.username);
    await addEditor(admin, page.id, b.username);
    const results = await Promise.all([transfer(admin, page.id, a.username), transfer(admin, page.id, b.username)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await PageMemberModel.countDocuments({ pageId: page.id, role: "admin" })).toBe(1);
  });
});
