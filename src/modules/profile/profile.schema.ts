import { z } from "zod";

// ********************* Update Profile Schema *********************

export const updateProfileSchema = z.object({
  displayName: z
    .string()
    .min(1)
    .max(100)
    .trim()
    .optional(),

  bio: z
    .string()
    .max(500)
    .trim()
    .optional(),
});