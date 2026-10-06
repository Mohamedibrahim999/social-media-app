import { z } from "zod";

export const subscribeBodySchema = z.object({ pageId: z.string().uuid() });
export const pageIdParamSchema = z.object({ pageId: z.string().uuid() });
