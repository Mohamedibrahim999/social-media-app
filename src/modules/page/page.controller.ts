import { Request, Response } from "express";
import * as pageService from "./page.service";
import { createPageSchema, pageIdParamSchema, updatePageSchema } from "./page.schema";
import { parsePagination } from "../../common/pagination/pagination";
import { AppError } from "../../common/errors/AppError";

export const createPage = async (req: Request, res: Response) => {
  const data = await pageService.createPage(req.user.accountId, createPageSchema.parse(req.body));
  res.status(201).json({ message: "Page created", data });
};

export const listMyPages = async (req: Request, res: Response) => {
  const data = await pageService.listMyPages(req.user.accountId, parsePagination(req.query));
  res.status(200).json({ message: "Pages fetched", data });
};

export const getPage = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  res.status(200).json({ message: "Page fetched", data: await pageService.getPage(pageId) });
};

export const updatePage = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  const data = await pageService.updatePage(pageId, req.user.accountId, updatePageSchema.parse(req.body));
  res.status(200).json({ message: "Page updated", data });
};

export const updatePagePicture = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  if (!req.file) throw new AppError("Image file is required (field name: image)", 400, "IMAGE_REQUIRED");
  const data = await pageService.updatePagePicture(pageId, req.user.accountId, `/uploads/pages/${req.file.filename}`);
  res.status(200).json({ message: "Page picture updated", data });
};

export const deletePage = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  const data = await pageService.deletePage(pageId, req.user.accountId);
  res.status(202).json({ message: "Page deleted; related data is being cleaned up", data });
};
