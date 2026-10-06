import { Router } from "express";
import * as controller from "./auth.controller";
import { authMiddleware } from "../../common/middleware/auth.middleware";
import {
  loginRateLimiter,
  loginVerifyRateLimiter,
  refreshRateLimiter,
  registerRateLimiter,
} from "../../common/middleware/rate-limit.middleware";

const router = Router();

router.post("/register", registerRateLimiter, controller.register);
router.post("/login", loginRateLimiter, controller.login);
router.post("/login/verify", loginVerifyRateLimiter, controller.verifyLogin);
router.post("/refresh", refreshRateLimiter, controller.refresh);
router.post("/logout", controller.logout);
router.post("/logout-all", controller.logoutAll);

router.patch("/password", authMiddleware, controller.changePassword);
router.patch("/username", authMiddleware, controller.changeUsername);
router.patch("/email", authMiddleware, controller.changeEmail);
router.delete("/account", authMiddleware, controller.deleteAccount);

export default router;
