import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

export interface IPage {
  _id: string;
  /**
   * accountId of the CURRENT ADMIN of the page. This single field is the
   * authoritative "exactly one admin" pointer: it can only ever hold one value,
   * and ownership is transferred with one atomic compare-and-set on this document.
   */
  accountId: string;
  name: string;
  description: string;
  picture: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const pageSchema = new Schema<IPage>(
  {
    _id: { type: String, default: () => randomUUID() },
    accountId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: "", trim: true, maxlength: 500 },
    picture: { type: String, default: null },
  },
  { timestamps: true }
);

export const PageModel = model<IPage>("Page", pageSchema);
