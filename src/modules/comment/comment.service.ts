import { AppError } from "../../common/errors/AppError";
import { Paginated, PaginationInput, toPaginated } from "../../common/pagination/pagination";
import { PersonSummary, loadPeople, personOrUnknown } from "../../common/utils/people";
import { findPostById } from "../post/post.repository";
import { findPageById } from "../page/page.repository";
import { IComment } from "./comment.model";
import {
  countRepliesFor,
  createComment as createCommentRecord,
  deleteCommentById,
  deleteRepliesOf,
  findCommentById,
  listReplies,
  listTopLevelComments,
  updateCommentContent,
} from "./comment.repository";

export interface CommentDto {
  id: string;
  postId: string;
  parentCommentId: string | null;
  author: PersonSummary;
  content: string;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type CommentRow = Pick<IComment, "_id" | "postId" | "parentCommentId" | "accountId" | "content" | "createdAt" | "updatedAt">;

const toDtos = async (rows: CommentRow[], withReplyCounts: boolean): Promise<CommentDto[]> => {
  const [people, counts] = await Promise.all([
    loadPeople(rows.map((row) => row.accountId)),
    withReplyCounts ? countRepliesFor(rows.map((row) => row._id)) : Promise.resolve(new Map<string, number>()),
  ]);
  return rows.map((row) => ({
    id: row._id,
    postId: row.postId,
    parentCommentId: row.parentCommentId,
    author: personOrUnknown(people, row.accountId),
    content: row.content,
    replyCount: counts.get(row._id) ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
};

const loadPost = async (postId: string) => {
  const post = await findPostById(postId);
  if (!post) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
  return post;
};

const loadComment = async (commentId: string) => {
  const comment = await findCommentById(commentId);
  if (!comment) throw new AppError("Comment not found", 404, "COMMENT_NOT_FOUND");
  return comment;
};

/** Any authenticated user may comment on an existing post. Replies are limited to depth 1. */
export const createComment = async (
  accountId: string,
  postId: string,
  input: { content: string; parentCommentId?: string }
) => {
  const post = await loadPost(postId);

  if (input.parentCommentId) {
    const parent = await loadComment(input.parentCommentId);
    if (parent.postId !== postId) {
      throw new AppError("Parent comment belongs to a different post", 400, "PARENT_COMMENT_MISMATCH");
    }
    if (parent.parentCommentId !== null) {
      throw new AppError("Replies cannot have replies (maximum depth is 1)", 400, "REPLY_DEPTH_EXCEEDED");
    }
  }

  const comment = await createCommentRecord({
    postId,
    pageId: post.pageId,
    accountId,
    content: input.content,
    parentCommentId: input.parentCommentId ?? null,
  });
  return (await toDtos([comment.toObject()], false))[0];
};

export const getComments = async (postId: string, pagination: PaginationInput): Promise<Paginated<CommentDto>> => {
  await loadPost(postId);
  const rows = await listTopLevelComments(postId, pagination.size + 1, pagination.position);
  const paged = toPaginated(rows, pagination);
  return { items: await toDtos(paged.items, true), pageInfo: paged.pageInfo };
};

export const getReplies = async (commentId: string, pagination: PaginationInput): Promise<Paginated<CommentDto>> => {
  const parent = await loadComment(commentId);
  if (parent.parentCommentId !== null) {
    throw new AppError("Replies cannot have replies", 400, "REPLY_DEPTH_EXCEEDED");
  }
  const rows = await listReplies(commentId, pagination.size + 1, pagination.position);
  const paged = toPaginated(rows, pagination);
  return { items: await toDtos(paged.items, false), pageInfo: paged.pageInfo };
};

export const editComment = async (accountId: string, commentId: string, content: string) => {
  const comment = await loadComment(commentId);
  if (comment.accountId !== accountId) {
    throw new AppError("You can only edit your own comments", 403, "FORBIDDEN_NOT_COMMENT_AUTHOR");
  }
  const updated = await updateCommentContent(commentId, content);
  if (!updated) throw new AppError("Comment not found", 404, "COMMENT_NOT_FOUND");
  return (await toDtos([updated.toObject()], false))[0];
};

/** Author or the admin of the page the post belongs to. Deleting a top-level comment deletes its replies. */
export const deleteComment = async (accountId: string, commentId: string) => {
  const comment = await loadComment(commentId);
  const page = await findPageById(comment.pageId);
  const isPageAdmin = page?.accountId === accountId;
  if (comment.accountId !== accountId && !isPageAdmin) {
    throw new AppError("Only the author or the page admin can delete this comment", 403, "FORBIDDEN_NOT_ALLOWED");
  }
  const deleted = await deleteCommentById(commentId);
  if (!deleted) throw new AppError("Comment not found", 404, "COMMENT_NOT_FOUND");
  const replies = await deleteRepliesOf([commentId]);
  return { success: true, deletedReplies: replies.deletedCount ?? 0 };
};
