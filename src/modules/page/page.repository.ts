import { PageModel } from "./page.model";
import { PageMemberModel, PageMemberRole } from "./page-member.model";

export const findPageById = async (pageId: string) => PageModel.findById(pageId);

export const findPagesByIds = async (pageIds: string[]) =>
  pageIds.length === 0 ? [] : PageModel.find({ _id: { $in: pageIds } });

export const createPage = async (data: { accountId: string; name: string; description: string }) =>
  PageModel.create(data);

export const updatePage = async (pageId: string, data: { name?: string; description?: string; picture?: string | null }) =>
  PageModel.findOneAndUpdate({ _id: pageId }, { $set: data }, { returnDocument: "after" });

/** Atomic delete guarded by the current admin: only the admin's request can win. */
export const deletePageAsAdmin = async (pageId: string, adminAccountId: string) =>
  PageModel.findOneAndDelete({ _id: pageId, accountId: adminAccountId });

export const deletePageById = async (pageId: string) => PageModel.findOneAndDelete({ _id: pageId });

export const findPagesAdministeredBy = async (accountId: string) => PageModel.find({ accountId });

/**
 * Admin transfer = ONE atomic compare-and-set on the page document. Works on a
 * standalone MongoDB (no transaction needed) because a single-document update is atomic:
 * of two concurrent transfers only one can match `accountId: currentAdmin`.
 */
export const swapPageAdmin = async (pageId: string, currentAdmin: string, newAdmin: string) =>
  PageModel.findOneAndUpdate(
    { _id: pageId, accountId: currentAdmin },
    { $set: { accountId: newAdmin } },
    { returnDocument: "after" }
  );

// ------------------------------------------------------------ members
export const findMember = async (pageId: string, accountId: string) => PageMemberModel.findOne({ pageId, accountId });

export const createMember = async (pageId: string, accountId: string, role: PageMemberRole) =>
  PageMemberModel.create({ pageId, accountId, role });

export const deleteMember = async (pageId: string, accountId: string) =>
  PageMemberModel.findOneAndDelete({ pageId, accountId });

export const listMembers = async (pageId: string, limit: number, skip: number) =>
  PageMemberModel.find({ pageId }).sort({ role: 1, createdAt: 1, _id: 1 }).skip(skip).limit(limit);

export const listMembershipsOfAccount = async (accountId: string, limit: number, skip: number) =>
  PageMemberModel.find({ accountId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit);

export const findAdminRow = async (pageId: string) => PageMemberModel.findOne({ pageId, role: "admin" });

/**
 * Brings the membership rows in line with the authoritative pointer Page.accountId:
 * demote any stale admin row first (so the partial unique index never sees two),
 * then upsert the real admin. Idempotent; safe to re-run after a crash.
 */
export const reconcileAdminRows = async (pageId: string, adminAccountId: string) => {
  await PageMemberModel.updateMany(
    { pageId, role: "admin", accountId: { $ne: adminAccountId } },
    { $set: { role: "editor" } }
  );
  await PageMemberModel.updateOne(
    { pageId, accountId: adminAccountId },
    { $set: { role: "admin" } },
    { upsert: true }
  );
};

export const deleteMembersOfPage = async (pageId: string) => PageMemberModel.deleteMany({ pageId });
export const deleteMembershipsOfAccount = async (accountId: string) => PageMemberModel.deleteMany({ accountId });
