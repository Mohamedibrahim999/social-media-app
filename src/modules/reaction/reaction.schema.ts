import { z } from "zod";
import { REACTION_TYPES } from "./reaction.model";

export const reactionTypes = REACTION_TYPES;
export const postIdParamSchema = z.object({ postId: z.string().uuid() });
export const reactionSchema = z.object({ type: z.enum(REACTION_TYPES) });
export const reactionFilterSchema = z.object({ type: z.enum(REACTION_TYPES).optional() });
