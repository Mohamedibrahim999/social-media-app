import { z } from "zod";

const username = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[A-Za-z0-9_.-]+$/, "Username may contain only letters, digits, '_', '.' and '-'");

// bcrypt only uses the first 72 bytes of a password.
const password = z.string().min(8).max(72);

export const registerSchema = z.object({
  username,
  email: z.string().trim().toLowerCase().email().max(254),
  password,
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(72),
});

export const verifyLoginSchema = z.object({
  externalId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20).max(4096),
});

export const changeUsernameSchema = z.object({ username });

export const changeEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: password,
});
