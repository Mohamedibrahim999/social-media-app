import { Request, Response } from "express";
import * as memberService from "./page-member.service";
import { memberUsernameBodySchema, memberUsernameParamSchema, pageIdParamSchema } from "./page.schema";
import { parsePagination } from "../../common/pagination/pagination";

export const listMembers = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  const data = await memberService.getMembers(pageId, req.user.accountId, parsePagination(req.query));
  res.status(200).json({ message: "Members fetched", data });
};

export const addEditor = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  const { username } = memberUsernameBodySchema.parse(req.body);
  res.status(201).json({ message: "Editor added", data: await memberService.addEditor(pageId, req.user.accountId, username) });
};

export const removeEditor = async (req: Request, res: Response) => {
  const { pageId, username } = memberUsernameParamSchema.parse(req.params);
  res.status(200).json({ message: "Editor removed", data: await memberService.removeEditor(pageId, req.user.accountId, username) });
};

export const transferAdmin = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  const { username } = memberUsernameBodySchema.parse(req.body);
  res.status(200).json({ message: "Admin role transferred", data: await memberService.transferAdmin(pageId, req.user.accountId, username) });
};

export const leavePage = async (req: Request, res: Response) => {
  const { pageId } = pageIdParamSchema.parse(req.params);
  res.status(200).json({ message: "You left the page", data: await memberService.leavePage(pageId, req.user.accountId) });
};
