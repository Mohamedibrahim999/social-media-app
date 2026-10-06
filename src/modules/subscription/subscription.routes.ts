import { Router } from "express";
import * as controller from "./subscription.controller";
import { authMiddleware } from "../../common/middleware/auth.middleware";

const router = Router();
router.use(authMiddleware);

router.post("/", controller.subscribe);
router.delete("/", controller.unsubscribe); // body: { pageId }  (kept for backwards compatibility)
router.get("/mine", controller.listMine);
router.get("/page/:pageId/subscribers", controller.listSubscribers);
router.delete("/:pageId", controller.unsubscribe);

export default router;
