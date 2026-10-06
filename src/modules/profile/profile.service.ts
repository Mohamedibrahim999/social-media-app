import { profilePictureOrDefault } from "../../common/constants/defaults";
import { deleteUploadedFile } from "../../common/utils/file-cleanup";
import {
  findProfileByAccountId,
  createProfile,
  updateProfile,
} from "./profile.repository";
import { findAccountByUsername } from "../auth/auth.repository";
import {
  updateProfileSchema,
} from "./profile.schema";

import { AppError } from "../../common/errors/AppError";

// ********************* Get My Profile *********************

export const getMyProfile = async (
  accountId: string
) => {
  const profile =
    await findProfileByAccountId(accountId);

  if (!profile) {
    throw new AppError(
      "Profile not found",
      404,
      "PROFILE_NOT_FOUND"
    );
  }

  return {
    accountId: profile.accountId,
    displayName: profile.displayName,
    bio: profile.bio,
    picture: profilePictureOrDefault(profile.picture),
  };
};

// ********************* Create Profile *********************

export const createMyProfile = async (
  accountId: string,
  input: unknown
) => {
  const data = updateProfileSchema.parse(input);

  const existingProfile =
    await findProfileByAccountId(accountId);

  if (existingProfile) {
    throw new AppError(
      "Profile already exists",
      409,
      "PROFILE_ALREADY_EXISTS"
    );
  }

  const profile = await createProfile({
    accountId,
    displayName: data.displayName ?? "",
    bio: data.bio ?? "",
    picture: null,
  });

  return {
    accountId: profile.accountId,
    displayName: profile.displayName,
    bio: profile.bio,
    picture: profilePictureOrDefault(profile.picture),
  };
};

// ********************* Update My Profile *********************

export const updateMyProfile = async (
  accountId: string,
  input: unknown
) => {
  const data = updateProfileSchema.parse(input);

  const profile =
    await findProfileByAccountId(accountId);

  if (!profile) {
    throw new AppError(
      "Profile not found",
      404,
      "PROFILE_NOT_FOUND"
    );
  }

  const updatedProfile =
    await updateProfile(accountId, data);

  if (!updatedProfile) {
    throw new AppError(
      "Profile update failed",
      500,
      "PROFILE_UPDATE_FAILED"
    );
  }

  return {
    accountId: updatedProfile.accountId,
    displayName: updatedProfile.displayName,
    bio: updatedProfile.bio,
    picture: profilePictureOrDefault(updatedProfile.picture),
  };
};

// ********************* Get Public Profile *********************

export const getPublicProfile = async (
  username: string
) => {
  const account =
    await findAccountByUsername(username);

  if (!account) {
    throw new AppError(
      "Profile not found",
      404,
      "PROFILE_NOT_FOUND"
    );
  }

  const profile =
    await findProfileByAccountId(
      account.externalId
    );

  if (!profile) {
    throw new AppError(
      "Profile not found",
      404,
      "PROFILE_NOT_FOUND"
    );
  }

  return {
    username: account.username,
    displayName: profile.displayName,
    bio: profile.bio,
    picture: profilePictureOrDefault(profile.picture),
  };
};

// ********************* Update Profile Picture *********************

export const updateProfilePicture = async (
  accountId: string,
  pictureUrl: string
) => {
  const profile =
    await findProfileByAccountId(accountId);

  if (!profile) {
    throw new AppError(
      "Profile not found",
      404,
      "PROFILE_NOT_FOUND"
    );
  }

  // Keep the old picture before updating the database
  const oldPicture = profile.picture;

  const updatedProfile =
    await updateProfile(accountId, {
      picture: pictureUrl,
    });

  if (!updatedProfile) {
    throw new AppError(
      "Profile picture update failed",
      500,
      "PROFILE_PICTURE_UPDATE_FAILED"
    );
  }

  // Delete the old file only after the database update succeeds
  if (
    oldPicture &&
    oldPicture !== updatedProfile.picture
  ) {
    await deleteUploadedFile(oldPicture);
  }

  return {
    accountId: updatedProfile.accountId,
    displayName: updatedProfile.displayName,
    bio: updatedProfile.bio,
    picture: profilePictureOrDefault(updatedProfile.picture),
  };
};
