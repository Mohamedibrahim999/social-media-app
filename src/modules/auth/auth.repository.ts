import { AccountModel } from "./auth.model";

export const findAccountByEmail = async (email: string) => AccountModel.findOne({ email: email.toLowerCase() });

export const findAccountByUsername = async (username: string) => AccountModel.findOne({ username });

export const findAccountByIdentifier = async (identifier: string) =>
  AccountModel.findOne({ $or: [{ email: identifier.toLowerCase() }, { username: identifier }] });

export const findAccountByExternalId = async (externalId: string) => AccountModel.findOne({ externalId });

export const findAccountsByExternalIds = async (externalIds: string[]) =>
  externalIds.length === 0
    ? []
    : AccountModel.find({ externalId: { $in: externalIds } }, { externalId: 1, username: 1, _id: 0 });

export const createAccount = async (data: {
  externalId: string;
  username: string;
  email: string;
  passwordHash: string;
}) => AccountModel.create(data);

const update = (accountId: string, set: Record<string, unknown>) =>
  AccountModel.findOneAndUpdate({ externalId: accountId }, { $set: set }, { returnDocument: "after" });

export const updateUsername = async (accountId: string, username: string) => update(accountId, { username });
export const updateEmail = async (accountId: string, email: string) => update(accountId, { email });
export const updatePassword = async (accountId: string, passwordHash: string) => update(accountId, { passwordHash });

export const deleteAccount = async (accountId: string) => AccountModel.findOneAndDelete({ externalId: accountId });
