import { CommentModel, IComment } from "./comment.model";

export const createComment = async (data: {
  postId: string;
  pageId: string;
  accountId: string;
  content: string;
  parentCommentId: string | null;
}) => CommentModel.create(data);

export const findCommentById = async (commentId: string) => CommentModel.findById(commentId);

export const updateCommentContent = async (commentId: string, content: string) =>
  CommentModel.findOneAndUpdate({ _id: commentId }, { $set: { content } }, { returnDocument: "after" });

export const deleteCommentById = async (commentId: string) => CommentModel.findOneAndDelete({ _id: commentId });
export const deleteRepliesOf = async (commentIds: string[]) =>
  commentIds.length === 0 ? { deletedCount: 0 } : CommentModel.deleteMany({ parentCommentId: { $in: commentIds } });

// Oldest first, with the unique _id as tie-breaker => total, stable order; skip/limit run in MongoDB.
export const listTopLevelComments = async (postId: string, limit: number, skip: number) =>
  CommentModel.find({ postId, parentCommentId: null }).sort({ createdAt: 1, _id: 1 }).skip(skip).limit(limit).lean<IComment[]>();

export const listReplies = async (parentCommentId: string, limit: number, skip: number) =>
  CommentModel.find({ parentCommentId }).sort({ createdAt: 1, _id: 1 }).skip(skip).limit(limit).lean<IComment[]>();

/** Reply counts for a whole page of comments in ONE aggregation (no per-comment query). */
export const countRepliesFor = async (commentIds: string[]): Promise<Map<string, number>> => {
  if (commentIds.length === 0) return new Map();
  const rows = await CommentModel.aggregate<{ _id: string; count: number }>([
    { $match: { parentCommentId: { $in: commentIds } } },
    { $group: { _id: "$parentCommentId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
};
