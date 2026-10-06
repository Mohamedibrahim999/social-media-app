import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt";
import { AppError } from "../errors/AppError";
import { isSessionActive } from "../../modules/auth/token-ancestry.repository";

export interface AuthenticatedRequest extends Request {
  user: { accountId: string; sessionId: string };
}

declare global {
  namespace Express {
    interface Request {
      user: { accountId: string; sessionId: string };
      uploadFolder?: string;
    }
  }
}

const unauthorized = (message = "Authentication required") => new AppError(message, 401, "UNAUTHORIZED");

/**
 * Verifies the Bearer access token AND that its sign-in chain has not been
 * revoked (logout, logout-all, password change, refresh-token reuse), so those
 * actions take effect immediately instead of after the 15-minute token expiry.
 */
export const authMiddleware = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const authorization = req.headers.authorization;
    if (!authorization) throw unauthorized();
    const [type, token] = authorization.split(" ");
    if (type !== "Bearer" || !token) throw unauthorized();

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw unauthorized("Invalid or expired access token");
    }
    if (!(await isSessionActive(payload.sessionId))) throw unauthorized("Session is no longer active");

    req.user = { accountId: payload.accountId, sessionId: payload.sessionId };
    next();
  } catch (error) {
    next(error);
  }
};
