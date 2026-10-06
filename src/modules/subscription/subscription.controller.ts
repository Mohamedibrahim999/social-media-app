import { Request, Response } from "express";
import * as service from "./subscription.service";
import { pageIdParamSchema, subscribeBodySchema } from "./subscription.schema";
import { parsePagination } from "../../common/pagination/pagination";

export const subscribe = async (req: Request, res: Response) => {
  const { pageId } = subscribeBodySchema.parse(req.body);
  const result = await service.subscribe(req.user.accountId, pageId);
  res.status(result.created ? 201 : 200).json({
    message: result.created ? "Subscribed" : "Already subscribed",
    data: result.data,
  });
};

export const unsubscribe = async (req: Request, res: Response) => {
  const source = req.params.pageId ? req.params : req.body;
  const { pageId } = pageIdParamSchema.parse(source);
  res.status(200).json({ message: "Unsubscribed", data: await service.unsubscribe(req.user.accountId, pageId) });
};

export const listMine = async (req: Request, res: Response) => {
  const data = await service.getMySubscriptions(req.user.accountId, parsePagination(req.query));
  res.status(200).json({ message: "Subscriptions fetched", data });
};

export const listSubscribers = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  const data = await service.getPageSubscribers(pageId, req.user.accountId, parsePagination(req.query));
  res.status(200).json({ message: "Subscribers fetched", data });
};
