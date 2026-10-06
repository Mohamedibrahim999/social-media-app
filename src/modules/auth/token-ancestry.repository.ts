import { createHash } from "crypto";
import { TokenAncestryModel } from "./token-ancestry.model";

export const hashRefreshToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const createTokenRecord = async (data: {
  tokenId: string;
  familyId: string;
  accountId: string;
  tokenHash: string;
  parentTokenId: string | null;
  expiresAt: Date;
}) => TokenAncestryModel.create({ ...data, status: "active" });

export const findTokenById = async (tokenId: string) => TokenAncestryModel.findOne({ tokenId });

/**
 * Atomic compare-and-set active -> superseded. Returns null if the token was no
 * longer active (already rotated, revoked or expired), which is how concurrent
 * refreshes with the same token are told apart: exactly one wins.
 */
export const supersedeToken = async (tokenId: string, replacedByTokenId: string) =>
  TokenAncestryModel.findOneAndUpdate(
    { tokenId, status: "active" },
    { $set: { status: "superseded", replacedByTokenId } },
    { returnDocument: "after" }
  );

export const revokeFamily = async (familyId: string, reason: string) =>
  TokenAncestryModel.updateMany(
    { familyId, status: { $ne: "revoked" } },
    { $set: { status: "revoked", revokedAt: new Date(), revokedReason: reason } }
  );

export const revokeAllAccountTokens = async (accountId: string, reason: string) =>
  TokenAncestryModel.updateMany(
    { accountId, status: { $ne: "revoked" } },
    { $set: { status: "revoked", revokedAt: new Date(), revokedReason: reason } }
  );

/** A sign-in chain is alive while it still owns an unexpired active refresh token. */
export const isSessionActive = async (familyId: string): Promise<boolean> => {
  const alive = await TokenAncestryModel.exists({
    familyId,
    status: "active",
    expiresAt: { $gt: new Date() },
  });
  return alive !== null;
};

export const deleteTokenRecordsByAccountId = async (accountId: string) =>
  TokenAncestryModel.deleteMany({ accountId });
