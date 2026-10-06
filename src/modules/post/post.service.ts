import { AppError } from "../../common/errors/AppError";
import { bumpVersion, deleteCache, deleteCacheByPattern, readThrough } from "../../common/cache/cache.service";
import { createCleanupJob } from "../../common/jobs/cleanup.job";
import { deleteUploadedFiles } from "../../common/utils/file-cleanup";
import { Paginated, PaginationInput, toPaginated } from "../../common/pagination/pagination";
import { PersonSummary, loadPeople, personOrUnknown } from "../../common/utils/people";
import { findPageById } from "../page/page.repository";
import { getPageRole, loadPage } from "../page/page.service";
import { IPost } from "./post.model";
import {
  createPost as createPostRecord,
  deletePostById,
  findPostById,
  listPostsOfAccount,
  listPostsOfPage,
  updatePost as updatePostRecord,
} from "./post.repository";

export interface PostDto {
  id: string;
  pageId: string;
  author: PersonSummary;
  content: string;
  images: string[];
  createdAt: Date;
  updatedAt: Date;
}

type PostRow = Pick<IPost, "_id" | "pageId" | "accountId" | "content" | "images" | "createdAt" | "updatedAt">;

/** Maps rows to DTOs resolving all authors with one batched lookup (no N+1). Display info is always fresh. */
export const toPostDtos = async (rows: PostRow[]): Promise<PostDto[]> => {
  const people = await loadPeople(rows.map((row) => row.accountId));
  return rows.map((row) => ({
    id: row._id,
    pageId: row.pageId,
    author: personOrUnknown(people, row.accountId),
    content: row.content,
    images: row.images,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
};

const postKey = (postId: string) => `post:id:${postId}`;

/** Called after ANY post mutation: drops post/list caches and invalidates every subscriber's feed in O(1). */
export const invalidatePostCaches = async (pageId: string, postId?: string, accountId?: string) => {
  if (postId) await deleteCache(postKey(postId));
  await deleteCacheByPattern(`post:page:${pageId}:*`);
  if (accountId) await deleteCacheByPattern(`post:account:${accountId}:*`);
  await bumpVersion(`page-posts:${pageId}`);
};

export const pageVersionName = (pageId: string) => `page-posts:${pageId}`;

export const createPost = async (accountId: string, input: { pageId: string; content: string }, images: string[]) => {
  const page = await loadPage(input.pageId);
  if (!(await getPageRole(page, accountId))) {
    throw new AppError("Only page members can publish posts", 403, "FORBIDDEN_NOT_PAGE_MEMBER");
  }
  if (!input.content && images.length === 0) {
    throw new AppError("A post needs text or at least one image", 400, "EMPTY_POST");
  }
  const post = await createPostRecord({ pageId: page._id, accountId, content: input.content, images });
  await invalidatePostCaches(page._id, undefined, accountId);
  return (await toPostDtos([post.toObject()]))[0];
};

export const getPost = async (postId: string): Promise<PostDto> => {
  const row = await readThrough<PostRow>(postKey(postId), async () => {
    const post = await findPostById(postId);
    if (!post) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
    return post.toObject();
  });
  return (await toPostDtos([row]))[0];
};

/** Author-only (and the author must still belong to the page). Replaced images are deleted from disk. */
export const editPost = async (
  postId: string,
  accountId: string,
  input: { content?: string; removeImages?: boolean },
  newImages: string[]
) => {
  const post = await findPostById(postId);
  if (!post) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
  if (post.accountId !== accountId) {
    throw new AppError("Only the author can edit this post", 403, "FORBIDDEN_NOT_POST_AUTHOR");
  }
  const page = await findPageById(post.pageId);
  if (!page || !(await getPageRole(page, accountId))) {
    throw new AppError("You are no longer a member of this page", 403, "FORBIDDEN_NOT_PAGE_MEMBER");
  }

  const replaceImages = newImages.length > 0 || input.removeImages === true;
  const nextImages = replaceImages ? newImages : post.images;
  const nextContent = input.content ?? post.content;
  if (!nextContent && nextImages.length === 0) {
    throw new AppError("A post needs text or at least one image", 400, "EMPTY_POST");
  }
  if (input.content === undefined && !replaceImages) {
    throw new AppError("Nothing to update", 400, "NOTHING_TO_UPDATE");
  }

  const updated = await updatePostRecord(postId, { content: nextContent, images: nextImages });
  if (!updated) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
  if (replaceImages) await deleteUploadedFiles(post.images); // old images are removed only after the DB write succeeded
  await invalidatePostCaches(post.pageId, postId, post.accountId);
  return (await toPostDtos([updated.toObject()]))[0];
};

/** Author or page admin. Dependent data (comments, replies, reactions, images, caches) is removed by the cleanup job. */
export const deletePost = async (postId: string, accountId: string) => {
  const post = await findPostById(postId);
  if (!post) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
  const page = await findPageById(post.pageId);
  const isAdmin = page?.accountId === accountId;
  if (post.accountId !== accountId && !isAdmin) {
    throw new AppError("Only the author or the page admin can delete this post", 403, "FORBIDDEN_NOT_ALLOWED");
  }

  const job = await createCleanupJob({
    type: "post",
    targetId: postId,
    requestedBy: accountId,
    metadata: { pageId: post.pageId, images: post.images },
  });
  const deleted = await deletePostById(postId);
  if (!deleted) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
  await invalidatePostCaches(post.pageId, postId, post.accountId);
  return { success: true, cleanupJobId: job._id };
};

export const listPagePosts = async (pageId: string, pagination: PaginationInput): Promise<Paginated<PostDto>> => {
  await loadPage(pageId);
  const rows = await readThrough<PostRow[]>(`post:page:${pageId}:${pagination.size}:${pagination.position}`, () =>
    listPostsOfPage(pageId, pagination.size + 1, pagination.position)
  );
  const paged = toPaginated(rows, pagination);
  return { items: await toPostDtos(paged.items), pageInfo: paged.pageInfo };
};

export const listMyPosts = async (accountId: string, pagination: PaginationInput): Promise<Paginated<PostDto>> => {
  const rows = await readThrough<PostRow[]>(`post:account:${accountId}:${pagination.size}:${pagination.position}`, () =>
    listPostsOfAccount(accountId, pagination.size + 1, pagination.position)
  );
  const paged = toPaginated(rows, pagination);
  return { items: await toPostDtos(paged.items), pageInfo: paged.pageInfo };
};
