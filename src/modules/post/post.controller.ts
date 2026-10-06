import { Request, Response } from "express";
import * as postService from "./post.service";
import { createPostSchema, editPostSchema, pageIdParamSchema, postIdParamSchema } from "./post.schema";
import { parsePagination } from "../../common/pagination/pagination";

const uploadedImagePaths = (req: Request): string[] =>
  (Array.isArray(req.files) ? req.files : []).map((file) => `/uploads/posts/${file.filename}`);

export const createPost = async (req: Request, res: Response) => {
  const input = createPostSchema.parse(req.body);
  const data = await postService.createPost(req.user.accountId, input, uploadedImagePaths(req));
  res.status(201).json({ message: "Post created", data });
};

export const getPost = async (req: Request, res: Response) => {
  const { postId } = postIdParamSchema.parse(req.params);
  res.status(200).json({ message: "Post fetched", data: await postService.getPost(postId) });
};

export const editPost = async (req: Request, res: Response) => {
  const { postId } = postIdParamSchema.parse(req.params);
  const input = editPostSchema.parse(req.body);
  const data = await postService.editPost(postId, req.user.accountId, input, uploadedImagePaths(req));
  res.status(200).json({ message: "Post updated", data });
};

export const deletePost = async (req: Request, res: Response) => {
  const { postId } = postIdParamSchema.parse(req.params);
  const data = await postService.deletePost(postId, req.user.accountId);
  res.status(202).json({ message: "Post deleted; related data is being cleaned up", data });
};

export const listPagePosts = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  res.status(200).json({ message: "Posts fetched", data: await postService.listPagePosts(pageId, parsePagination(req.query)) });
};

export const listMyPosts = async (req: Request, res: Response) => {
  res.status(200).json({ message: "Posts fetched", data: await postService.listMyPosts(req.user.accountId, parsePagination(req.query)) });
};
