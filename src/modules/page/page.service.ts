import { AppError } from "../../common/errors/AppError";
import { pagePictureOrDefault } from "../../common/constants/defaults";
import { deleteCache, deleteCacheByPattern, readThrough } from "../../common/cache/cache.service";
import { createCleanupJob } from "../../common/jobs/cleanup.job";
import { deleteUploadedFiles } from "../../common/utils/file-cleanup";
import { Paginated, PaginationInput, toPaginated } from "../../common/pagination/pagination";
import { IPage } from "./page.model";
import {
  createMember,
  createPage as createPageRecord,
  deletePageAsAdmin,
  deletePageById,
  findMember,
  findPageById,
  findPagesByIds,
  listMembershipsOfAccount,
  updatePage as updatePageRecord,
} from "./page.repository";

export type PageRole = "admin" | "editor";

export interface PageDto {
  id: string;
  name: string;
  description: string;
  picture: string;
  adminAccountId: string;
  createdAt: Date;
  updatedAt: Date;
}

export const toPageDto = (page: Pick<IPage, "_id" | "name" | "description" | "picture" | "accountId" | "createdAt" | "updatedAt">): PageDto => ({
  id: page._id,
  name: page.name,
  description: page.description,
  picture: pagePictureOrDefault(page.picture),
  adminAccountId: page.accountId,
  createdAt: page.createdAt,
  updatedAt: page.updatedAt,
});

export const pageCacheKey = (pageId: string) => `page:id:${pageId}`;
export const invalidatePageCache = async (pageId: string) => {
  await deleteCache(pageCacheKey(pageId));
};

export const loadPage = async (pageId: string) => {
  const page = await findPageById(pageId);
  if (!page) throw new AppError("Page not found", 404, "PAGE_NOT_FOUND");
  return page;
};

/** admin = Page.accountId (authoritative pointer); editor = membership row; otherwise null. */
export const getPageRole = async (page: { _id: string; accountId: string }, accountId: string): Promise<PageRole | null> => {
  if (page.accountId === accountId) return "admin";
  const member = await findMember(page._id, accountId);
  return member ? "editor" : null;
};

export const assertAdmin = (page: { accountId: string }, accountId: string) => {
  if (page.accountId !== accountId) {
    throw new AppError("Only the page admin can perform this action", 403, "FORBIDDEN_NOT_PAGE_ADMIN");
  }
};

export const createPage = async (accountId: string, input: { name: string; description: string }) => {
  const page = await createPageRecord({ accountId, ...input });
  try {
    await createMember(page._id, accountId, "admin");
  } catch (error) {
    await deletePageById(page._id);
    throw error;
  }
  return toPageDto(page);
};

export const getPage = async (pageId: string): Promise<PageDto> =>
  readThrough(pageCacheKey(pageId), async () => toPageDto(await loadPage(pageId)));

export const updatePage = async (pageId: string, accountId: string, data: { name?: string; description?: string }) => {
  assertAdmin(await loadPage(pageId), accountId);
  const updated = await updatePageRecord(pageId, data);
  if (!updated) throw new AppError("Page not found", 404, "PAGE_NOT_FOUND");
  await invalidatePageCache(pageId);
  return toPageDto(updated);
};

/** `newPicture` was already written to disk by the upload middleware. */
export const updatePagePicture = async (pageId: string, accountId: string, newPicture: string) => {
  const page = await loadPage(pageId);
  assertAdmin(page, accountId);
  const updated = await updatePageRecord(pageId, { picture: newPicture });
  if (!updated) throw new AppError("Page not found", 404, "PAGE_NOT_FOUND");
  if (page.picture) await deleteUploadedFiles([page.picture]); // replaced picture must not linger on disk
  await invalidatePageCache(pageId);
  return toPageDto(updated);
};

/**
 * Deleting a page removes the page document immediately and queues a cleanup job
 * for everything else (members, subscriptions, posts, comments, reactions, images, cache).
 * The job is enqueued first (outbox); the worker waits until the page is really gone.
 */
export const deletePage = async (pageId: string, accountId: string) => {
  const page = await loadPage(pageId);
  assertAdmin(page, accountId);
  const job = await createCleanupJob({
    type: "page",
    targetId: pageId,
    requestedBy: accountId,
    metadata: { picture: page.picture },
  });
  const deleted = await deletePageAsAdmin(pageId, accountId);
  if (!deleted) throw new AppError("Page not found or admin changed", 409, "PAGE_DELETE_CONFLICT");
  await invalidatePageCache(pageId);
  await deleteCacheByPattern(`post:page:${pageId}:*`);
  return { success: true, cleanupJobId: job._id };
};

export interface MyPageDto extends PageDto {
  role: PageRole;
}

export const listMyPages = async (accountId: string, pagination: PaginationInput): Promise<Paginated<MyPageDto>> => {
  const rows = await listMembershipsOfAccount(accountId, pagination.size + 1, pagination.position);
  const paged = toPaginated(rows, pagination);
  const pages = new Map((await findPagesByIds(paged.items.map((row) => row.pageId))).map((page) => [page._id, page]));
  const items: MyPageDto[] = [];
  for (const row of paged.items) {
    const page = pages.get(row.pageId);
    if (page) items.push({ ...toPageDto(page), role: page.accountId === accountId ? "admin" : "editor" });
  }
  return { items, pageInfo: paged.pageInfo };
};
