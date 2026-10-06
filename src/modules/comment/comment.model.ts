import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

export interface IComment {
  _id: string;
  postId: string;
  pageId: string;
  accountId: string;
  content: string;
  parentCommentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const commentSchema = new Schema<IComment>(
  {
    _id: { type: String, default: () => randomUUID() },
    postId: { type: String, required: true, index: true },
    // Denormalised so "page admin may delete any comment of the page" needs no extra lookup.
    pageId: { type: String, required: true, index: true },
    accountId: { type: String, required: true, index: true },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
    parentCommentId: { type: String, default: null, index: true },
  },
  { timestamps: true }
);

// Top-level comments of a post / replies of a comment, oldest first with a unique tie-breaker.
commentSchema.index({ postId: 1, parentCommentId: 1, createdAt: 1, _id: 1 });
commentSchema.index({ parentCommentId: 1, createdAt: 1, _id: 1 });

export const CommentModel = model<IComment>("Comment", commentSchema);
