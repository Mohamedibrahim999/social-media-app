import { Router } from "express";
import * as pages from "./page.controller";
import * as members from "./page-member.controller";
import { authMiddleware } from "../../common/middleware/auth.middleware";
import { pagePictureUpload } from "../../common/middleware/upload.middleware";

const router = Router();
router.use(authMiddleware);

// Pages
router.post("/", pages.createPage);
router.get("/mine", pages.listMyPages); // must stay above "/:pageId"
router.get("/:pageId", pages.getPage);
router.patch("/:pageId", pages.updatePage);
router.delete("/:pageId", pages.deletePage);
router.post("/:pageId/picture", ...pagePictureUpload, pages.updatePagePicture);

// Members
router.get("/:pageId/members", members.listMembers);
router.post("/:pageId/members/editors", members.addEditor);
router.delete("/:pageId/members/editors/:username", members.removeEditor);
router.patch("/:pageId/members/admin", members.transferAdmin);
router.delete("/:pageId/members/me", members.leavePage);

export default router;
