import { Router } from "express";
import * as controller from "./comment.controller";
import { authMiddleware } from "../../common/middleware/auth.middleware";

const router = Router();
router.use(authMiddleware);

router.post("/post/:postId", controller.createComment); // body.parentCommentId => reply
router.get("/post/:postId", controller.getComments); // top-level comments (with replyCount)
router.get("/:commentId/replies", controller.getReplies);
router.patch("/:commentId", controller.editComment);
router.delete("/:commentId", controller.deleteComment);

export default router;
