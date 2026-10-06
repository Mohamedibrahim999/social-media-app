import {
  Request,
  Response,
  NextFunction,
} from "express";

import {
  getMyProfile,
  createMyProfile,
  updateMyProfile,
  getPublicProfile,
   updateProfilePicture
} from "./profile.service";

import { AuthenticatedRequest } from "../../common/middleware/auth.middleware";
import { AppError } from "../../common/errors/AppError";

// ********************* Get My Profile *********************

export const getMyProfileController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const accountId = (
      req as AuthenticatedRequest
    ).user.accountId;

    const result = await getMyProfile(
      accountId
    );

    res.status(200).json({
      message: "Profile fetched successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ********************* Create My Profile *********************

export const createMyProfileController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const accountId = (
      req as AuthenticatedRequest
    ).user.accountId;

    const result = await createMyProfile(
      accountId,
      req.body
    );

    res.status(201).json({
      message: "Profile created successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ********************* Update My Profile *********************

export const updateMyProfileController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const accountId = (
      req as AuthenticatedRequest
    ).user.accountId;

    const result = await updateMyProfile(
      accountId,
      req.body
    );

    res.status(200).json({
      message: "Profile updated successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
// ********************* Get Public Profile *********************

export const getPublicProfileController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const username = req.params.username as string;

const result =
  await getPublicProfile(username);

    res.status(200).json({
      message: "Profile fetched successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ********************* Update Profile Picture *********************

export const updateProfilePictureController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const accountId = (
      req as AuthenticatedRequest
    ).user.accountId;

    if (!req.file) {
      throw new AppError(
        "Profile picture is required",
        400,
        "PROFILE_PICTURE_REQUIRED"
      );
    }

    const pictureUrl =
      `/uploads/profiles/${req.file.filename}`;

    const result =
      await updateProfilePicture(
        accountId,
        pictureUrl
      );

    res.status(200).json({
      message:
        "Profile picture updated successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};