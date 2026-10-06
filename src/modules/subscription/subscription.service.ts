import { AppError } from "../../common/errors/AppError";
import { Paginated, PaginationInput, toPaginated } from "../../common/pagination/pagination";
import { PersonSummary, loadPeople, personOrUnknown } from "../../common/utils/people";
import { findPageById, findPagesByIds } from "../page/page.repository";
import { PageDto, assertAdmin, toPageDto } from "../page/page.service";
import {
  deleteSubscription,
  listSubscribersOfPage,
  listSubscriptionsOfAccount,
  upsertSubscription,
} from "./subscription.repository";

export const subscribe = async (accountId: string, pageId: string) => {
  if (!(await findPageById(pageId))) throw new AppError("Page not found", 404, "PAGE_NOT_FOUND");
  const { created } = await upsertSubscription(accountId, pageId);
  return { created, data: { pageId, subscribed: true } };
};

/** Idempotent: unsubscribing from a page you are not subscribed to succeeds and changes nothing. */
export const unsubscribe = async (accountId: string, pageId: string) => {
  const result = await deleteSubscription(accountId, pageId);
  return { pageId, subscribed: false, removed: result.deletedCount > 0 };
};

export interface SubscribedPageDto extends PageDto {
  subscribedAt: Date;
}

export const getMySubscriptions = async (
  accountId: string,
  pagination: PaginationInput
): Promise<Paginated<SubscribedPageDto>> => {
  const rows = await listSubscriptionsOfAccount(accountId, pagination.size + 1, pagination.position);
  const paged = toPaginated(rows, pagination);
  const pages = new Map((await findPagesByIds(paged.items.map((row) => row.pageId))).map((page) => [page._id, page]));
  const items: SubscribedPageDto[] = [];
  for (const row of paged.items) {
    const page = pages.get(row.pageId);
    if (page) items.push({ ...toPageDto(page), subscribedAt: row.createdAt });
  }
  return { items, pageInfo: paged.pageInfo };
};

export interface SubscriberDto extends PersonSummary {
  subscribedAt: Date;
}

export const getPageSubscribers = async (
  pageId: string,
  requesterId: string,
  pagination: PaginationInput
): Promise<Paginated<SubscriberDto>> => {
  const page = await findPageById(pageId);
  if (!page) throw new AppError("Page not found", 404, "PAGE_NOT_FOUND");
  assertAdmin(page, requesterId); // only the page admin sees the subscriber list

  const rows = await listSubscribersOfPage(pageId, pagination.size + 1, pagination.position);
  const paged = toPaginated(rows, pagination);
  const people = await loadPeople(paged.items.map((row) => row.accountId));
  return {
    items: paged.items.map((row) => ({ ...personOrUnknown(people, row.accountId), subscribedAt: row.createdAt })),
    pageInfo: paged.pageInfo,
  };
};
