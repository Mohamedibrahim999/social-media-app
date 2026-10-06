import { createHash } from "crypto";
import { getVersions, readThrough } from "../../common/cache/cache.service";
import { Paginated, PaginationInput, toPaginated } from "../../common/pagination/pagination";
import { findPagesByIds } from "../page/page.repository";
import { pagePictureOrDefault } from "../../common/constants/defaults";
import { findSubscribedPageIds } from "../subscription/subscription.repository";
import { listPostsOfPages } from "../post/post.repository";
import { IPost } from "../post/post.model";
import { PostDto, pageVersionName, toPostDtos } from "../post/post.service";

export interface FeedItemDto extends PostDto {
  page: { id: string; name: string; picture: string } | null;
}

type PostRow = Pick<IPost, "_id" | "pageId" | "accountId" | "content" | "images" | "createdAt" | "updatedAt">;

/**
 * Feed = posts of the pages the caller is subscribed to – nothing else
 * (no recommendations, no trending, no sampling).
 *
 * DB-side pagination: skip/limit/sort are executed by MongoDB over the index
 * (pageId, createdAt, _id). Order (createdAt DESC, _id DESC) is total => stable.
 *
 * Cache: the key embeds the subscribed page set and each page's post-version, so
 * unsubscribing or any post create/edit/delete makes the old entry unreachable immediately.
 * Page/author display data is joined fresh (2 batched queries) so renames never go stale.
 */
export const getMyFeed = async (accountId: string, pagination: PaginationInput): Promise<Paginated<FeedItemDto>> => {
  const pageIds = await findSubscribedPageIds(accountId);
  const versions = await getVersions(pageIds.map(pageVersionName));
  const fingerprint = createHash("sha1")
    .update(pageIds.map((id, index) => `${id}:${versions[index]}`).join("|"))
    .digest("hex")
    .slice(0, 20);

  const rows = await readThrough<PostRow[]>(
    `feed:account:${accountId}:${fingerprint}:${pagination.size}:${pagination.position}`,
    () => listPostsOfPages(pageIds, pagination.size + 1, pagination.position),
    120
  );

  const paged = toPaginated(rows, pagination);
  const [posts, pages] = await Promise.all([
    toPostDtos(paged.items),
    findPagesByIds([...new Set(paged.items.map((row) => row.pageId))]),
  ]);
  const pageById = new Map(pages.map((page) => [page._id, page]));

  return {
    items: posts.map((post) => {
      const page = pageById.get(post.pageId);
      return { ...post, page: page ? { id: page._id, name: page.name, picture: pagePictureOrDefault(page.picture) } : null };
    }),
    pageInfo: paged.pageInfo,
  };
};
