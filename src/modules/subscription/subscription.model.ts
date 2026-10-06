import { Schema, model } from "mongoose";

export interface ISubscription {
  accountId: string;
  pageId: string;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    accountId: {
      type: String,
      required: true,
      index: true,
    },

    pageId: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// One user can subscribe to a page only once.
subscriptionSchema.index(
  { accountId: 1, pageId: 1 },
  { unique: true }
);

subscriptionSchema.index({ pageId: 1, createdAt: -1, _id: -1 });
subscriptionSchema.index({ accountId: 1, createdAt: -1, _id: -1 });

export const SubscriptionModel =
  model<ISubscription>("Subscription", subscriptionSchema);
