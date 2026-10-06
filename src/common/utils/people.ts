import { findAccountsByExternalIds } from "../../modules/auth/auth.repository";
import { findProfilesByAccountIds } from "../../modules/profile/profile.repository";
import { profilePictureOrDefault } from "../constants/defaults";

export interface PersonSummary {
  accountId: string;
  username: string | null;
  displayName: string | null;
  picture: string;
}

/**
 * Resolves public display info for many accounts with exactly TWO queries
 * (accounts + profiles) regardless of list length – this is what prevents N+1 lookups.
 * E-mail addresses are never part of the summary.
 */
export const loadPeople = async (accountIds: string[]): Promise<Map<string, PersonSummary>> => {
  const unique = [...new Set(accountIds)];
  const [accounts, profiles] = await Promise.all([findAccountsByExternalIds(unique), findProfilesByAccountIds(unique)]);
  const usernames = new Map(accounts.map((account) => [account.externalId, account.username]));
  const profileById = new Map(profiles.map((profile) => [profile.accountId, profile]));

  const result = new Map<string, PersonSummary>();
  for (const id of unique) {
    const profile = profileById.get(id);
    result.set(id, {
      accountId: id,
      username: usernames.get(id) ?? null, // null => account was deleted
      displayName: profile?.displayName ?? usernames.get(id) ?? null,
      picture: profilePictureOrDefault(profile?.picture),
    });
  }
  return result;
};

export const personOrUnknown = (people: Map<string, PersonSummary>, accountId: string): PersonSummary =>
  people.get(accountId) ?? { accountId, username: null, displayName: null, picture: profilePictureOrDefault(null) };
