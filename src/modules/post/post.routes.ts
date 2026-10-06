import { Router } from "express";
import * as controller from "./post.controller";
import { authMiddleware } from "../../common/middleware/auth.middleware";
import { postImagesUpload } from "../../common/middleware/upload.middleware";

const router = Router();
router.use(authMiddleware);

router.get("/me", controller.listMyPosts);
router.get("/page/:pageId", controller.listPagePosts);
router.post("/", ...postImagesUpload, controller.createPost);
router.get("/:postId", controller.getPost);
router.patch("/:postId", ...postImagesUpload, controller.editPost);
router.delete("/:postId", controller.deletePost);

export default router;
