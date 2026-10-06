import { Request, Response } from "express";
import * as service from "./comment.service";
import { commentIdParamSchema, createCommentSchema, postIdParamSchema, updateCommentSchema } from "./comment.schema";
import { parsePagination } from "../../common/pagination/pagination";

export const createComment = async (req: Request, res: Response) => {
  const { postId } = postIdParamSchema.parse(req.params);
  const data = await service.createComment(req.user.accountId, postId, createCommentSchema.parse(req.body));
  res.status(201).json({ message: data.parentCommentId ? "Reply created" : "Comment created", data });
};

export const getComments = async (req: Request, res: Response) => {
  const { postId } = postIdParamSchema.parse(req.params);
  res.status(200).json({ message: "Comments fetched", data: await service.getComments(postId, parsePagination(req.query)) });
};

export const getReplies = async (req: Request, res: Response) => {
  const { commentId } = commentIdParamSchema.parse(req.params);
  res.status(200).json({ message: "Replies fetched", data: await service.getReplies(commentId, parsePagination(req.query)) });
};

export const editComment = async (req: Request, res: Response) => {
  const { commentId } = commentIdParamSchema.parse(req.params);
  const { content } = updateCommentSchema.parse(req.body);
  res.status(200).json({ message: "Comment updated", data: await service.editComment(req.user.accountId, commentId, content) });
};

export const deleteComment = async (req: Request, res: Response) => {
  const { commentId } = commentIdParamSchema.parse(req.params);
  res.status(200).json({ message: "Comment deleted", data: await service.deleteComment(req.user.accountId, commentId) });
};
