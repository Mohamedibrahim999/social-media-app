import { AppError } from "../../common/errors/AppError";
import { deleteCache } from "../../common/cache/cache.service";
import { Paginated, PaginationInput, toPaginated } from "../../common/pagination/pagination";
import { PersonSummary, loadPeople, personOrUnknown } from "../../common/utils/people";
import { findAccountByUsername } from "../auth/auth.repository";
import {
  createMember,
  deleteMember,
  findAdminRow,
  findMember,
  listMembers,
  reconcileAdminRows,
  swapPageAdmin,
} from "./page.repository";
import { assertAdmin, getPageRole, invalidatePageCache, loadPage, PageRole } from "./page.service";

export interface MemberDto extends PersonSummary {
  role: PageRole;
  joinedAt: Date;
}

const resolveTarget = async (username: string) => {
  const account = await findAccountByUsername(username);
  if (!account) throw new AppError("User not found", 404, "USER_NOT_FOUND");
  return account;
};

const afterMembershipChange = async (pageId: string, ...accountIds: string[]) => {
  await invalidatePageCache(pageId);
  await deleteCache(...accountIds.map((id) => `page:mine:${id}`));
};

export const getMembers = async (
  pageId: string,
  requesterId: string,
  pagination: PaginationInput
): Promise<Paginated<MemberDto>> => {
  const page = await loadPage(pageId);
  if (!(await getPageRole(page, requesterId))) {
    throw new AppError("Only page members can list members", 403, "FORBIDDEN_NOT_PAGE_MEMBER");
  }
  // Self-heal a half-finished admin transfer (crash between the CAS and the role sync).
  const adminRow = await findAdminRow(pageId);
  if (!adminRow || adminRow.accountId !== page.accountId) await reconcileAdminRows(pageId, page.accountId);

  const rows = await listMembers(pageId, pagination.size + 1, pagination.position);
  const paged = toPaginated(rows, pagination);
  const people = await loadPeople(paged.items.map((row) => row.accountId));
  return {
    items: paged.items.map((row) => ({
      ...personOrUnknown(people, row.accountId),
      role: row.accountId === page.accountId ? ("admin" as const) : ("editor" as const),
      joinedAt: row.createdAt,
    })),
    pageInfo: paged.pageInfo,
  };
};

export const addEditor = async (pageId: string, adminId: string, username: string) => {
  const page = await loadPage(pageId);
  assertAdmin(page, adminId);
  const target = await resolveTarget(username);
  if (await findMember(pageId, target.externalId)) {
    throw new AppError("User is already a member of this page", 409, "ALREADY_MEMBER");
  }
  try {
    await createMember(pageId, target.externalId, "editor"); // unique(pageId, accountId) guards races
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new AppError("User is already a member of this page", 409, "ALREADY_MEMBER");
    }
    throw error;
  }
  await afterMembershipChange(pageId, target.externalId);
  return { pageId, accountId: target.externalId, username: target.username, role: "editor" as const };
};

export const removeEditor = async (pageId: string, adminId: string, username: string) => {
  const page = await loadPage(pageId);
  assertAdmin(page, adminId);
  const target = await resolveTarget(username);
  if (target.externalId === page.accountId) {
    throw new AppError("The admin cannot be removed; transfer the admin role first", 400, "CANNOT_REMOVE_ADMIN");
  }
  const removed = await deleteMember(pageId, target.externalId);
  if (!removed) throw new AppError("User is not a member of this page", 404, "MEMBER_NOT_FOUND");
  await afterMembershipChange(pageId, target.externalId);
  return { success: true };
};

/** An editor may leave; the admin may not (there must always be an admin). */
export const leavePage = async (pageId: string, accountId: string) => {
  const page = await loadPage(pageId);
  if (page.accountId === accountId) {
    throw new AppError("The admin cannot leave the page; transfer the admin role first", 409, "ADMIN_CANNOT_LEAVE");
  }
  const removed = await deleteMember(pageId, accountId);
  if (!removed) throw new AppError("You are not a member of this page", 404, "MEMBER_NOT_FOUND");
  await afterMembershipChange(pageId, accountId);
  return { success: true };
};

/**
 * Consistency model (standalone MongoDB, no transactions):
 *  1. ONE atomic compare-and-set on the page document moves the admin pointer
 *     (`accountId: currentAdmin` -> `newAdmin`). This is the linearisation point; the page
 *     has exactly one admin before and after it, and concurrent transfers cannot both succeed.
 *  2. Membership rows are then re-synchronised idempotently (demote old admin, then promote new).
 *     A crash between 1 and 2 is harmless: authorisation reads the pointer, and the next
 *     members listing / transfer re-runs the reconciliation.
 *  The partial unique index `one_admin_per_page` guarantees at most one admin row at any time.
 */
export const transferAdmin = async (pageId: string, adminId: string, username: string) => {
  const page = await loadPage(pageId);
  assertAdmin(page, adminId);
  const target = await resolveTarget(username);

  if (target.externalId === adminId) {
    throw new AppError("You are already the admin", 400, "CANNOT_TRANSFER_TO_SELF");
  }
  const membership = await findMember(pageId, target.externalId);
  if (!membership || membership.role !== "editor") {
    throw new AppError("Admin role can only be transferred to an existing editor", 400, "TARGET_NOT_EDITOR");
  }

  const swapped = await swapPageAdmin(pageId, adminId, target.externalId);
  if (!swapped) {
    throw new AppError("Admin changed while processing the request", 409, "ADMIN_TRANSFER_CONFLICT");
  }
  await reconcileAdminRows(pageId, target.externalId);
  await afterMembershipChange(pageId, adminId, target.externalId);
  return { pageId, newAdminAccountId: target.externalId, newAdminUsername: target.username, previousAdminAccountId: adminId };
};
