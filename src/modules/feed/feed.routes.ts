import { Router } from "express";
import { getFeed } from "./feed.controller";
import { authMiddleware } from "../../common/middleware/auth.middleware";

const router = Router();
router.get("/", authMiddleware, getFeed);

export default router;
