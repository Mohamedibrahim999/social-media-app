import { Schema, model } from "mongoose";

export const REACTION_TYPES = [
  "like",
  "love",
  "haha",
  "wow",
  "sad",
  "angry",
] as const;

export type ReactionType =
  (typeof REACTION_TYPES)[number];

export interface IReaction {
  postId: string;
  accountId: string;
  type: ReactionType;
  createdAt: Date;
  updatedAt: Date;
}

const reactionSchema =
  new Schema<IReaction>(
    {
      postId: {
        type: String,
        required: true,
        index: true,
      },

      accountId: {
        type: String,
        required: true,
        index: true,
      },

      type: {
        type: String,
        enum: REACTION_TYPES,
        required: true,
      },
    },
    {
      timestamps: true,
    }
  );

reactionSchema.index(
  {
    postId: 1,
    accountId: 1,
  },
  {
    unique: true,
  }
);

reactionSchema.index({ postId: 1, type: 1, createdAt: -1, _id: -1 });

export const ReactionModel =
  model<IReaction>(
    "Reaction",
    reactionSchema
  );
