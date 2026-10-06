import { IReaction, ReactionModel, ReactionType, REACTION_TYPES } from "./reaction.model";

/**
 * Atomic upsert on unique(postId, accountId): the first reaction inserts, a change replaces the type,
 * and two simultaneous requests can never produce a duplicate-key error or a second row.
 */
export const upsertReaction = async (postId: string, accountId: string, type: ReactionType) => {
  const run = () =>
    ReactionModel.findOneAndUpdate({ postId, accountId }, { $set: { type } }, { upsert: true, returnDocument: "after" });
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return run(); // lost the upsert race: the row exists now, just update it
    throw error;
  }
};

export const deleteReaction = async (postId: string, accountId: string) => ReactionModel.deleteOne({ postId, accountId });

export const findReaction = async (postId: string, accountId: string) => ReactionModel.findOne({ postId, accountId });

export const listReactions = async (postId: string, type: ReactionType | undefined, limit: number, skip: number) =>
  ReactionModel.find(type ? { postId, type } : { postId })
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .lean<IReaction[]>();

export const countReactionsByType = async (postId: string): Promise<Record<ReactionType | "total", number>> => {
  const rows = await ReactionModel.aggregate<{ _id: ReactionType; count: number }>([
    { $match: { postId } },
    { $group: { _id: "$type", count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(REACTION_TYPES.map((type) => [type, 0])) as Record<ReactionType | "total", number>;
  counts.total = 0;
  for (const row of rows) {
    counts[row._id] = row.count;
    counts.total += row.count;
  }
  return counts;
};

export const deleteReactionsOfPosts = async (postIds: string[]) =>
  postIds.length === 0 ? { deletedCount: 0 } : ReactionModel.deleteMany({ postId: { $in: postIds } });
export const deleteReactionsOfAccount = async (accountId: string) => ReactionModel.deleteMany({ accountId });
export const distinctPostIdsReactedBy = async (accountId: string) => ReactionModel.distinct("postId", { accountId });
