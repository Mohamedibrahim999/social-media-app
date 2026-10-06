import { SubscriptionModel } from "./subscription.model";

/** Atomic upsert: concurrent duplicate subscribes can never create two rows or raise a duplicate-key error. */
export const upsertSubscription = async (accountId: string, pageId: string): Promise<{ created: boolean }> => {
  try {
    const result = await SubscriptionModel.updateOne(
      { accountId, pageId },
      { $setOnInsert: { accountId, pageId } },
      { upsert: true }
    );
    return { created: result.upsertedCount > 0 };
  } catch (error) {
    // A concurrent identical upsert can still lose the race on the unique index: the row exists => success.
    if ((error as { code?: number }).code === 11000) return { created: false };
    throw error;
  }
};

export const deleteSubscription = async (accountId: string, pageId: string) =>
  SubscriptionModel.deleteOne({ accountId, pageId });

export const listSubscriptionsOfAccount = async (accountId: string, limit: number, skip: number) =>
  SubscriptionModel.find({ accountId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit);

export const listSubscribersOfPage = async (pageId: string, limit: number, skip: number) =>
  SubscriptionModel.find({ pageId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit);

export const findSubscribedPageIds = async (accountId: string): Promise<string[]> =>
  (await SubscriptionModel.find({ accountId }, { pageId: 1, _id: 0 }).sort({ pageId: 1 }).lean()).map((row) => row.pageId);

export const deleteSubscriptionsOfAccount = async (accountId: string) => SubscriptionModel.deleteMany({ accountId });
export const deleteSubscriptionsOfPage = async (pageId: string) => SubscriptionModel.deleteMany({ pageId });
export const findSubscriberIdsOfPage = async (pageId: string): Promise<string[]> =>
  (await SubscriptionModel.find({ pageId }, { accountId: 1, _id: 0 }).lean()).map((row) => row.accountId);
