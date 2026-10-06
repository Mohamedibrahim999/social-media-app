import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

export interface IPost {
  _id: string;
  pageId: string;
  accountId: string;
  content: string;
  images: string[];
  createdAt: Date;
  updatedAt: Date;
}

const postSchema = new Schema<IPost>(
  {
    _id: { type: String, default: () => randomUUID() },
    pageId: { type: String, required: true, index: true },
    accountId: { type: String, required: true, index: true },
    content: { type: String, default: "", trim: true, maxlength: 5000 },
    images: { type: [String], default: [] },
  },
  { timestamps: true }
);

// Feed / page listing: newest first with a unique tie-breaker (_id) => stable ordering.
postSchema.index({ pageId: 1, createdAt: -1, _id: -1 });
postSchema.index({ accountId: 1, createdAt: -1, _id: -1 });

export const PostModel = model<IPost>("Post", postSchema);
