import jwt from "jsonwebtoken";
import { env } from "../../config/env";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface AccessTokenPayload {
  accountId: string;
  /** sign-in chain (session family) this access token belongs to */
  sessionId: string;
  type: "access";
}

export interface RefreshTokenPayload {
  accountId: string;
  sessionId: string;
  type: "refresh";
  jti: string;
}

export const generateAccessToken = (accountId: string, sessionId: string): string =>
  jwt.sign({ accountId, sid: sessionId, type: "access" }, env.JWT_ACCESS_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    algorithm: "HS256",
  });

export const generateRefreshToken = (accountId: string, sessionId: string, tokenId: string): string =>
  jwt.sign({ accountId, sid: sessionId, type: "refresh" }, env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_TTL_SECONDS,
    jwtid: tokenId,
    algorithm: "HS256",
  });

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  if (decoded.type !== "access" || typeof decoded.accountId !== "string" || typeof decoded.sid !== "string") {
    throw new Error("Invalid access token");
  }
  return { accountId: decoded.accountId, sessionId: decoded.sid, type: "access" };
};

export const verifyRefreshToken = (token: string): RefreshTokenPayload => {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  if (
    decoded.type !== "refresh" ||
    typeof decoded.accountId !== "string" ||
    typeof decoded.sid !== "string" ||
    typeof decoded.jti !== "string"
  ) {
    throw new Error("Invalid refresh token");
  }
  return { accountId: decoded.accountId, sessionId: decoded.sid, type: "refresh", jti: decoded.jti };
};
