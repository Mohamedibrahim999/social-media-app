import { Schema, model } from "mongoose";

export type PageMemberRole = "admin" | "editor";

export interface IPageMember {
  pageId: string;
  accountId: string;
  role: PageMemberRole;
  createdAt: Date;
  updatedAt: Date;
}

const pageMemberSchema = new Schema<IPageMember>(
  {
    pageId: { type: String, required: true },
    accountId: { type: String, required: true, index: true },
    role: { type: String, enum: ["admin", "editor"], required: true },
  },
  { timestamps: true }
);

// A person is a member of a page at most once.
pageMemberSchema.index({ pageId: 1, accountId: 1 }, { unique: true });

pageMemberSchema.index({ pageId: 1, role: 1, createdAt: 1, _id: 1 });

// At most ONE admin membership row per page, enforced by the database.
// (The authoritative admin pointer is Page.accountId – see page.service.ts.)
pageMemberSchema.index(
  { pageId: 1 },
  { unique: true, partialFilterExpression: { role: "admin" }, name: "one_admin_per_page" }
);


export const PageMemberModel = model<IPageMember>("PageMember", pageMemberSchema);
