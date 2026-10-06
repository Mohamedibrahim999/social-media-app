import { Request, Response } from "express";
import * as authService from "./auth.service";
import {
  changeEmailSchema,
  changePasswordSchema,
  changeUsernameSchema,
  loginSchema,
  refreshTokenSchema,
  registerSchema,
  verifyLoginSchema,
} from "./auth.schema";

// Express 5 forwards rejected promises to the error middleware, so no try/catch boilerplate is needed.

export const register = async (req: Request, res: Response) => {
  const data = await authService.register(registerSchema.parse(req.body));
  res.status(201).json({ message: "Registration successful", data });
};

export const login = async (req: Request, res: Response) => {
  const data = await authService.login(loginSchema.parse(req.body));
  res.status(200).json({
    message: data.requiresVerification ? "Verification code sent" : "Login successful",
    data,
  });
};

export const verifyLogin = async (req: Request, res: Response) => {
  const data = await authService.verifyEmailLogin(verifyLoginSchema.parse(req.body));
  res.status(200).json({ message: "Login successful", data });
};

export const refresh = async (req: Request, res: Response) => {
  const { refreshToken } = refreshTokenSchema.parse(req.body);
  res.status(200).json({ message: "Token refreshed", data: await authService.refresh(refreshToken) });
};

export const logout = async (req: Request, res: Response) => {
  const { refreshToken } = refreshTokenSchema.parse(req.body);
  res.status(200).json({ message: "Logged out", data: await authService.logout(refreshToken) });
};

export const logoutAll = async (req: Request, res: Response) => {
  const { refreshToken } = refreshTokenSchema.parse(req.body);
  res.status(200).json({ message: "Logged out from all sessions", data: await authService.logoutAll(refreshToken) });
};

export const changePassword = async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  const data = await authService.changePassword(req.user.accountId, currentPassword, newPassword);
  res.status(200).json({ message: "Password changed; all other sessions were revoked", data });
};

export const changeUsername = async (req: Request, res: Response) => {
  const { username } = changeUsernameSchema.parse(req.body);
  res.status(200).json({ message: "Username updated", data: await authService.changeUsername(req.user.accountId, username) });
};

export const changeEmail = async (req: Request, res: Response) => {
  const { email } = changeEmailSchema.parse(req.body);
  res.status(200).json({ message: "Email updated", data: await authService.changeEmail(req.user.accountId, email) });
};

export const deleteAccount = async (req: Request, res: Response) => {
  res.status(202).json({
    message: "Account deleted; related data is being cleaned up",
    data: await authService.deleteAccount(req.user.accountId),
  });
};
