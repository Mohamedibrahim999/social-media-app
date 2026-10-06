import { Request, Response } from "express";
import { getMyFeed } from "./feed.service";
import { parsePagination } from "../../common/pagination/pagination";

export const getFeed = async (req: Request, res: Response) => {
  const data = await getMyFeed(req.user.accountId, parsePagination(req.query));
  res.status(200).json({ message: "Feed fetched", data });
};
