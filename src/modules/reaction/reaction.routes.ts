import { Router } from "express";
import * as controller from "./reaction.controller";
import { authMiddleware } from "../../common/middleware/auth.middleware";

const router = Router();
router.use(authMiddleware);

router.post("/post/:postId", controller.reactToPost);
router.delete("/post/:postId", controller.removeReaction);
router.get("/post/:postId", controller.getPostReactions); // ?type=like&size=&position=

export default router;
