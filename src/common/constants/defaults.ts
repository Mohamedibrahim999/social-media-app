export const DEFAULT_PROFILE_PICTURE = "/uploads/defaults/profile.png";
export const DEFAULT_PAGE_PICTURE = "/uploads/defaults/page.png";

export const profilePictureOrDefault = (picture: string | null | undefined): string =>
  picture || DEFAULT_PROFILE_PICTURE;
export const pagePictureOrDefault = (picture: string | null | undefined): string => picture || DEFAULT_PAGE_PICTURE;
