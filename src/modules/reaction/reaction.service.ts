import { AppError } from "../../common/errors/AppError";
import { Paginated, PaginationInput, toPaginated } from "../../common/pagination/pagination";
import { PersonSummary, loadPeople, personOrUnknown } from "../../common/utils/people";
import { findPostById } from "../post/post.repository";
import { ReactionType } from "./reaction.model";
import { countReactionsByType, deleteReaction, findReaction, listReactions, upsertReaction } from "./reaction.repository";

export interface ReactionSummary {
  counts: Record<ReactionType | "total", number>;
  myReaction: ReactionType | null;
}

const assertPostExists = async (postId: string) => {
  if (!(await findPostById(postId))) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
};

const summary = async (postId: string, accountId: string): Promise<ReactionSummary> => {
  const [counts, mine] = await Promise.all([countReactionsByType(postId), findReaction(postId, accountId)]);
  return { counts, myReaction: mine?.type ?? null };
};

/** One reaction per user per post: reacting again replaces the previous type. Any authenticated user may react. */
export const reactToPost = async (accountId: string, postId: string, type: ReactionType) => {
  await assertPostExists(postId);
  await upsertReaction(postId, accountId, type);
  return summary(postId, accountId);
};

export const removeReaction = async (accountId: string, postId: string) => {
  await assertPostExists(postId);
  await deleteReaction(postId, accountId); // idempotent
  return summary(postId, accountId);
};

export interface ReactionItem extends PersonSummary {
  type: ReactionType;
  reactedAt: Date;
}

export const getPostReactions = async (
  accountId: string,
  postId: string,
  type: ReactionType | undefined,
  pagination: PaginationInput
): Promise<ReactionSummary & Paginated<ReactionItem>> => {
  await assertPostExists(postId);
  const rows = await listReactions(postId, type, pagination.size + 1, pagination.position);
  const paged = toPaginated(rows, pagination);
  const [people, base] = await Promise.all([loadPeople(paged.items.map((row) => row.accountId)), summary(postId, accountId)]);
  return {
    ...base,
    items: paged.items.map((row) => ({ ...personOrUnknown(people, row.accountId), type: row.type, reactedAt: row.createdAt })),
    pageInfo: paged.pageInfo,
  };
};
