import { PostModel, IPost } from "./post.model";

export const createPost = async (data: { pageId: string; accountId: string; content: string; images: string[] }) =>
  PostModel.create(data);

export const findPostById = async (postId: string) => PostModel.findById(postId);

export const updatePost = async (postId: string, data: { content?: string; images?: string[] }) =>
  PostModel.findOneAndUpdate({ _id: postId }, { $set: data }, { returnDocument: "after" });

export const deletePostById = async (postId: string) => PostModel.findOneAndDelete({ _id: postId });

// Every listing sorts by (createdAt DESC, _id DESC): _id is unique, so the order is total and stable,
// and skip/limit run inside MongoDB. We ask for size+1 rows to learn whether a next page exists.
export const listPostsOfPage = async (pageId: string, limit: number, skip: number) =>
  PostModel.find({ pageId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<IPost[]>();

export const listPostsOfAccount = async (accountId: string, limit: number, skip: number) =>
  PostModel.find({ accountId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<IPost[]>();

export const listPostsOfPages = async (pageIds: string[], limit: number, skip: number) =>
  pageIds.length === 0
    ? []
    : PostModel.find({ pageId: { $in: pageIds } }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<IPost[]>();
