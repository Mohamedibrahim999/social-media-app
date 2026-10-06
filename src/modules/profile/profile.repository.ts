import { ProfileModel } from "./profile.model";

// ********************* Find Profile By Account ID *********************

export const findProfileByAccountId = async (
  accountId: string
) => {
  return ProfileModel.findOne({
    accountId,
  });
};

// ********************* Create Profile *********************

export const createProfile = async (data: {
  accountId: string;
  displayName: string;
  bio?: string;
  picture?: string | null;
}) => {
  return ProfileModel.create(data);
};

// ********************* Update Profile *********************

export const updateProfile = async (
  accountId: string,
  data: {
    displayName?: string;
    bio?: string;
    picture?: string | null;
  }
) => {
  return ProfileModel.findOneAndUpdate(
    {
      accountId,
    },
    {
      $set: data,
    },
    {
      returnDocument: "after",
    }
  );
};
// ********************* Delete Profile *********************

export const deleteProfile = async (
  accountId: string
) => {
  return ProfileModel.findOneAndDelete({
    accountId,
  });
};

export const findProfilesByAccountIds = async (accountIds: string[]) =>
  accountIds.length === 0 ? [] : ProfileModel.find({ accountId: { $in: accountIds } });
