import { Schema, model } from "mongoose";

export type SessionTokenStatus = "active" | "superseded" | "revoked";

/**
 * One document per issued refresh token (collection kept as `token_ancestry`).
 *
 *  familyId          sign-in chain: every token produced by rotating the same login shares it
 *  tokenHash         SHA-256 of the refresh token (the raw token is never stored anywhere)
 *  parentTokenId     the token this one replaced (lineage)
 *  replacedByTokenId the token that replaced this one (set when superseded)
 *  status            active | superseded (rotated away) | revoked (logout / reuse / password change)
 */
export interface ITokenAncestry {
  tokenId: string;
  familyId: string;
  accountId: string;
  tokenHash: string;
  parentTokenId: string | null;
  replacedByTokenId: string | null;
  status: SessionTokenStatus;
  revokedAt: Date | null;
  revokedReason: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const tokenAncestrySchema = new Schema<ITokenAncestry>(
  {
    tokenId: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    accountId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true },
    parentTokenId: { type: String, default: null },
    replacedByTokenId: { type: String, default: null },
    status: { type: String, enum: ["active", "superseded", "revoked"], required: true, default: "active" },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    // TTL index: expired sessions are purged automatically by MongoDB.
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true, collection: "token_ancestry" }
);

export const TokenAncestryModel = model<ITokenAncestry>("TokenAncestry", tokenAncestrySchema);
