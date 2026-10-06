import { Router } from "express";
import { authMiddleware } from "../../common/middleware/auth.middleware";
import { profilePictureUpload } from "../../common/middleware/upload.middleware";
import {
  createMyProfileController,
  getMyProfileController,
  getPublicProfileController,
  updateMyProfileController,
  updateProfilePictureController,
} from "./profile.controller";

const router = Router();

router.get("/me", authMiddleware, getMyProfileController);
router.post("/picture", authMiddleware, ...profilePictureUpload, updateProfilePictureController);
router.get("/:username", getPublicProfileController);
router.post("/", authMiddleware, createMyProfileController);
router.patch("/", authMiddleware, updateMyProfileController);

export default router;
