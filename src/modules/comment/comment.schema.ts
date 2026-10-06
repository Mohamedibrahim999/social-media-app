import { z } from "zod";

export const commentIdParamSchema = z.object({ commentId: z.string().uuid() });
export const postIdParamSchema = z.object({ postId: z.string().uuid() });

export const createCommentSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  parentCommentId: z.string().uuid().optional(),
});

export const updateCommentSchema = z.object({
  content: z.string().trim().min(1).max(2000),
});
