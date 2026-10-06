import { z } from "zod";

export const pageIdParamSchema = z.object({ pageId: z.string().uuid() });

export const createPageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().default(""),
});

export const updatePageSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "Provide at least one field to update",
  });

const usernameField = z.string().trim().min(3).max(30);
export const memberUsernameBodySchema = z.object({ username: usernameField });
export const memberUsernameParamSchema = z.object({ pageId: z.string().uuid(), username: usernameField });
