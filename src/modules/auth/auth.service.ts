import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { AppError } from "../../common/errors/AppError";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from "../../common/utils/jwt";
import { sendVerificationCode } from "../../common/services/email.service";
import { createCleanupJob } from "../../common/jobs/cleanup.job";
import {
  createAccount,
  deleteAccount as deleteAccountRecord,
  findAccountByEmail,
  findAccountByExternalId,
  findAccountByIdentifier,
  findAccountByUsername,
  updateEmail,
  updatePassword,
  updateUsername,
} from "./auth.repository";
import {
  createTokenRecord,
  findTokenById,
  hashRefreshToken,
  revokeAllAccountTokens,
  revokeFamily,
  supersedeToken,
} from "./token-ancestry.repository";
import { generateAndStoreOtp, invalidateOtp, verifyOtp } from "./otp.service";
import { createProfile } from "../profile/profile.repository";

const BCRYPT_ROUNDS = 12;
// Compared against when the account does not exist so that unknown and known
// accounts cost the same time (no timing-based account enumeration).
const DUMMY_HASH = bcrypt.hashSync("tapi-dummy-password", BCRYPT_ROUNDS);

const invalidCredentials = () => new AppError("Invalid credentials", 401, "INVALID_CREDENTIALS");
const invalidRefresh = () => new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

const buildTokenPair = async (accountId: string, familyId: string, parentTokenId: string | null) => {
  const tokenId = randomUUID();
  const refreshToken = generateRefreshToken(accountId, familyId, tokenId);
  await createTokenRecord({
    tokenId,
    familyId,
    accountId,
    tokenHash: hashRefreshToken(refreshToken),
    parentTokenId,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
  });
  const pair: TokenPair = {
    accessToken: generateAccessToken(accountId, familyId),
    refreshToken,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
  };
  return { pair, tokenId };
};

/** Starts a new sign-in chain (one per login). */
const startSession = async (accountId: string): Promise<TokenPair> =>
  (await buildTokenPair(accountId, randomUUID(), null)).pair;

const duplicateKey = (error: unknown): "username" | "email" | null => {
  const e = error as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  if (e?.code !== 11000) return null;
  const text = `${Object.keys(e.keyPattern ?? {}).join(",")} ${e.message ?? ""}`;
  if (text.includes("email")) return "email";
  if (text.includes("username")) return "username";
  return null;
};

// ---------------------------------------------------------------- register
/**
 * Enumeration protection: usernames are public identifiers (public profile
 * lookup), so a taken username is reported with 409. A taken E-MAIL is private:
 * the response is byte-for-byte shaped like a success (201) and no account is created.
 */
export const register = async (input: { username: string; email: string; password: string }) => {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS); // always hash: constant work either way

  if (await findAccountByUsername(input.username)) {
    throw new AppError("Username is already taken", 409, "USERNAME_TAKEN");
  }

  const fake = () => ({ externalId: randomUUID(), username: input.username, email: input.email });

  if (await findAccountByEmail(input.email)) return fake();

  const externalId = randomUUID();
  try {
    await createAccount({ externalId, username: input.username, email: input.email, passwordHash });
  } catch (error) {
    const key = duplicateKey(error);
    if (key === "username") throw new AppError("Username is already taken", 409, "USERNAME_TAKEN");
    if (key === "email") return fake();
    throw error;
  }

  try {
    await createProfile({ accountId: externalId, displayName: input.username });
  } catch (error) {
    await deleteAccountRecord(externalId);
    throw error;
  }
  return { externalId, username: input.username, email: input.email };
};

// ------------------------------------------------------------------- login
export const login = async (input: { identifier: string; password: string }) => {
  const account = await findAccountByIdentifier(input.identifier);
  const passwordOk = await bcrypt.compare(input.password, account?.passwordHash ?? DUMMY_HASH);
  if (!account || !passwordOk) throw invalidCredentials();

  const isEmailLogin = input.identifier.toLowerCase() === account.email;
  if (!isEmailLogin) {
    return { requiresVerification: false as const, ...(await startSession(account.externalId)) };
  }

  const code = await generateAndStoreOtp(account.externalId); // replaces any previous code
  try {
    await sendVerificationCode(account.email, code);
  } catch (error) {
    await invalidateOtp(account.externalId);
    console.error("Failed to deliver verification e-mail:", (error as Error).message);
    throw new AppError("Could not send the verification code", 503, "EMAIL_DELIVERY_FAILED");
  }
  return { requiresVerification: true as const, externalId: account.externalId };
};

export const verifyEmailLogin = async (input: { externalId: string; code: string }) => {
  const account = await findAccountByExternalId(input.externalId);
  const ok = account ? await verifyOtp(account.externalId, input.code) : false;
  if (!account || !ok) throw new AppError("Invalid or expired verification code", 401, "INVALID_VERIFICATION_CODE");
  return startSession(account.externalId);
};

// ----------------------------------------------------------------- refresh
export const refresh = async (refreshToken: string): Promise<TokenPair> => {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw invalidRefresh();
  }

  const record = await findTokenById(payload.jti);
  if (
    !record ||
    record.accountId !== payload.accountId ||
    record.familyId !== payload.sessionId ||
    record.tokenHash !== hashRefreshToken(refreshToken)
  ) {
    throw invalidRefresh();
  }

  // A superseded token is being presented again => it was stolen or replayed: kill the whole chain.
  if (record.status === "superseded") {
    await revokeFamily(record.familyId, "refresh_token_reuse");
    throw new AppError("Refresh token reuse detected; session revoked", 401, "REFRESH_TOKEN_REUSED");
  }
  if (record.status !== "active" || record.expiresAt <= new Date()) throw invalidRefresh();

  const { pair, tokenId: newTokenId } = await buildTokenPair(record.accountId, record.familyId, record.tokenId);

  // Atomic CAS: of two concurrent refreshes with the same token only one can win.
  const superseded = await supersedeToken(record.tokenId, newTokenId);
  if (!superseded) {
    await revokeFamily(record.familyId, "refresh_token_reuse");
    throw new AppError("Refresh token reuse detected; session revoked", 401, "REFRESH_TOKEN_REUSED");
  }
  return pair;
};

// ------------------------------------------------------------------ logout
const readRefresh = (refreshToken: string) => {
  try {
    return verifyRefreshToken(refreshToken);
  } catch {
    throw invalidRefresh();
  }
};

/** Ends the sign-in chain of this device. Idempotent. */
export const logout = async (refreshToken: string) => {
  const payload = readRefresh(refreshToken);
  const record = await findTokenById(payload.jti);
  if (record && record.accountId === payload.accountId && record.tokenHash === hashRefreshToken(refreshToken)) {
    await revokeFamily(record.familyId, "logout");
  }
  return { success: true };
};

export const logoutAll = async (refreshToken: string) => {
  const payload = readRefresh(refreshToken);
  const record = await findTokenById(payload.jti);
  if (!record || record.accountId !== payload.accountId || record.tokenHash !== hashRefreshToken(refreshToken)) {
    throw invalidRefresh();
  }
  await revokeAllAccountTokens(record.accountId, "logout_all");
  return { success: true };
};

// ---------------------------------------------------------- account changes
export const changePassword = async (accountId: string, currentPassword: string, newPassword: string) => {
  const account = await findAccountByExternalId(accountId);
  if (!account) throw new AppError("Account not found", 404, "ACCOUNT_NOT_FOUND");
  if (!(await bcrypt.compare(currentPassword, account.passwordHash))) {
    throw new AppError("Current password is incorrect", 400, "INVALID_CURRENT_PASSWORD");
  }
  if (currentPassword === newPassword) {
    throw new AppError("New password must differ from the current password", 400, "PASSWORD_UNCHANGED");
  }
  await updatePassword(accountId, await bcrypt.hash(newPassword, BCRYPT_ROUNDS));
  await revokeAllAccountTokens(accountId, "password_changed"); // every other device/session dies
  await invalidateOtp(accountId);
  return { success: true, ...(await startSession(accountId)) }; // fresh session for the device that changed it
};

export const changeUsername = async (accountId: string, username: string) => {
  const existing = await findAccountByUsername(username);
  if (existing && existing.externalId !== accountId) {
    throw new AppError("Username is already taken", 409, "USERNAME_TAKEN");
  }
  try {
    const account = await updateUsername(accountId, username);
    if (!account) throw new AppError("Account not found", 404, "ACCOUNT_NOT_FOUND");
    return { externalId: account.externalId, username: account.username };
  } catch (error) {
    if (duplicateKey(error)) throw new AppError("Username is already taken", 409, "USERNAME_TAKEN");
    throw error;
  }
};

export const changeEmail = async (accountId: string, email: string) => {
  const existing = await findAccountByEmail(email);
  if (existing && existing.externalId !== accountId) {
    throw new AppError("Email is already in use", 409, "EMAIL_ALREADY_EXISTS");
  }
  try {
    const account = await updateEmail(accountId, email);
    if (!account) throw new AppError("Account not found", 404, "ACCOUNT_NOT_FOUND");
    await invalidateOtp(accountId);
    return { externalId: account.externalId, email: account.email };
  } catch (error) {
    if (duplicateKey(error)) throw new AppError("Email is already in use", 409, "EMAIL_ALREADY_EXISTS");
    throw error;
  }
};

/**
 * The account and its sessions disappear immediately; everything else
 * (pages, posts, comments, reactions, subscriptions, memberships, images, cache)
 * is removed by the background cleanup job. The job is enqueued BEFORE the
 * deletion (outbox pattern): the worker only runs once the account is really gone.
 */
export const deleteAccount = async (accountId: string) => {
  const account = await findAccountByExternalId(accountId);
  if (!account) throw new AppError("Account not found", 404, "ACCOUNT_NOT_FOUND");

  const job = await createCleanupJob({ type: "account", targetId: accountId, requestedBy: accountId });
  await revokeAllAccountTokens(accountId, "account_deleted");
  await deleteAccountRecord(accountId);
  // The profile row is intentionally left for the cleanup job: it still needs it to find and delete the picture file.
  await invalidateOtp(accountId);
  return { success: true, cleanupJobId: job._id };
};
