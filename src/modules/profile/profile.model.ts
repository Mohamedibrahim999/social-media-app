import { Schema, model } from "mongoose";

export interface IProfile {
  accountId: string;
  displayName: string;
  bio: string;
  picture: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const profileSchema = new Schema<IProfile>(
  {
    accountId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    bio: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    picture: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

export const ProfileModel = model<IProfile>(
  "Profile",
  profileSchema
);