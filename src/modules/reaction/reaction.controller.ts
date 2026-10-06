import { Request, Response } from "express";
import * as service from "./reaction.service";
import { postIdParamSchema, reactionFilterSchema, reactionSchema } from "./reaction.schema";
import { parsePagination } from "../../common/pagination/pagination";

export const reactToPost = async (req: Request, res: Response) => {
  const { postId } = postIdParamSchema.parse(req.params);
  const { type } = reactionSchema.parse(req.body);
  res.status(200).json({ message: "Reaction saved", data: await service.reactToPost(req.user.accountId, postId, type) });
};

export const removeReaction = async (req: Request, res: Response) => {
  const { postId } = postIdParamSchema.parse(req.params);
  res.status(200).json({ message: "Reaction removed", data: await service.removeReaction(req.user.accountId, postId) });
};

export const getPostReactions = async (req: Request, res: Response) => {
  const { postId } = postIdParamSchema.parse(req.params);
  const { type } = reactionFilterSchema.parse(req.query);
  const data = await service.getPostReactions(req.user.accountId, postId, type, parsePagination(req.query));
  res.status(200).json({ message: "Reactions fetched", data });
};
