import { z } from "zod";

export const postIdParamSchema = z.object({ postId: z.string().uuid() });
export const pageIdParamSchema = z.object({ pageId: z.string().uuid() });

export const createPostSchema = z.object({
  pageId: z.string().uuid(),
  content: z.string().trim().max(5000).optional().default(""),
});

const booleanField = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const editPostSchema = z.object({
  content: z.string().trim().max(5000).optional(),
  removeImages: booleanField.optional(),
});
