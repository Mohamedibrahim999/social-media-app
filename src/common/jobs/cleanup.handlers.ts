import { CommentModel } from "../../modules/comment/comment.model";
import { PostModel } from "../../modules/post/post.model";
import { ReactionModel } from "../../modules/reaction/reaction.model";
import { SubscriptionModel } from "../../modules/subscription/subscription.model";
import { PageModel } from "../../modules/page/page.model";
import { PageMemberModel } from "../../modules/page/page-member.model";
import { ProfileModel } from "../../modules/profile/profile.model";
import { AccountModel } from "../../modules/auth/auth.model";
import { TokenAncestryModel } from "../../modules/auth/token-ancestry.model";
import { bumpVersion, deleteCache, deleteCacheByPattern } from "../cache/cache.service";
import { deleteUploadedFiles } from "../utils/file-cleanup";
import { redisClient } from "../../config/redis";
import { ICleanupJob } from "./cleanup.model";

const BATCH = 200;

/** Thrown when the object a job is about to clean up still exists (the originating delete has not happened). */
export class PreconditionNotMetError extends Error {}

/** Everything that hangs off a set of posts: comments, replies, reactions, image files, caches. */
const purgePostDependents = async (posts: { _id: string; pageId: string; accountId: string; images: string[] }[]) => {
  if (posts.length === 0) return;
  const ids = posts.map((post) => post._id);
  await CommentModel.deleteMany({ postId: { $in: ids } }); // comments AND replies carry postId
  await ReactionModel.deleteMany({ postId: { $in: ids } });
  await deleteUploadedFiles(posts.flatMap((post) => post.images));
  await deleteCache(...ids.map((id) => `post:id:${id}`));
  for (const pageId of new Set(posts.map((post) => post.pageId))) {
    await deleteCacheByPattern(`post:page:${pageId}:*`);
    await bumpVersion(`page-posts:${pageId}`); // invalidates every subscriber's feed
  }
  for (const accountId of new Set(posts.map((post) => post.accountId))) {
    await deleteCacheByPattern(`post:account:${accountId}:*`);
  }
};

const deleteAllPostsMatching = async (filter: Record<string, unknown>) => {
  for (;;) {
    const posts = await PostModel.find(filter).limit(BATCH).lean();
    if (posts.length === 0) return;
    await purgePostDependents(posts);
    await PostModel.deleteMany({ _id: { $in: posts.map((post) => post._id) } });
  }
};

// ----------------------------------------------------------------- handlers
export const handlePostCleanup = async (job: ICleanupJob) => {
  if (await PostModel.exists({ _id: job.targetId })) throw new PreconditionNotMetError("Post still exists");
  const metadata = (job.metadata ?? {}) as { pageId?: string; images?: string[] };
  await purgePostDependents([
    { _id: job.targetId, pageId: metadata.pageId ?? "", accountId: "", images: metadata.images ?? [] },
  ]);
  await CommentModel.deleteMany({ postId: job.targetId });
  await ReactionModel.deleteMany({ postId: job.targetId });
};

const purgePageData = async (pageId: string, picture: string | null | undefined) => {
  await deleteAllPostsMatching({ pageId });
  await CommentModel.deleteMany({ pageId }); // safety net for stragglers
  await SubscriptionModel.deleteMany({ pageId });
  await PageMemberModel.deleteMany({ pageId });
  await deleteUploadedFiles(picture ? [picture] : []);
  await deleteCache(`page:id:${pageId}`);
  await deleteCacheByPattern(`post:page:${pageId}:*`);
  await bumpVersion(`page-posts:${pageId}`);
};

export const handlePageCleanup = async (job: ICleanupJob) => {
  if (await PageModel.exists({ _id: job.targetId })) throw new PreconditionNotMetError("Page still exists");
  const metadata = (job.metadata ?? {}) as { picture?: string | null };
  await purgePageData(job.targetId, metadata.picture);
};

export const handleAccountCleanup = async (job: ICleanupJob) => {
  const accountId = job.targetId;
  if (await AccountModel.exists({ externalId: accountId })) throw new PreconditionNotMetError("Account still exists");

  // 1. Pages this account administers are removed together with all of their content.
  for (const page of await PageModel.find({ accountId }).lean()) {
    await purgePageData(page._id, page.picture);
    await PageModel.deleteOne({ _id: page._id });
  }
  // 2. Posts the account wrote on pages it only edited.
  await deleteAllPostsMatching({ accountId });
  // 3. Its comments (and the replies other people wrote under them).
  for (;;) {
    const mine = await CommentModel.find({ accountId }, { _id: 1 }).limit(BATCH).lean();
    if (mine.length === 0) break;
    const ids = mine.map((comment) => comment._id);
    await CommentModel.deleteMany({ parentCommentId: { $in: ids } });
    await CommentModel.deleteMany({ _id: { $in: ids } });
  }
  // 4. Everything else keyed by the account.
  await ReactionModel.deleteMany({ accountId });
  await SubscriptionModel.deleteMany({ accountId });
  await PageMemberModel.deleteMany({ accountId });
  const profile = await ProfileModel.findOneAndDelete({ accountId });
  await deleteUploadedFiles(profile?.picture ? [profile.picture] : []);
  await TokenAncestryModel.deleteMany({ accountId });
  await redisClient.del([`auth:login:otp:${accountId}`, `auth:login:otp:attempts:${accountId}`]);
  await deleteCacheByPattern(`post:account:${accountId}:*`);
  await deleteCacheByPattern(`feed:account:${accountId}:*`);
};

export const cleanupHandlers = {
  post: handlePostCleanup,
  page: handlePageCleanup,
  account: handleAccountCleanup,
} as const;
