import { create } from "zustand";

import {
  EMPTY_ACCOUNT_STATE,
  type Account,
  type AccountState,
  type UserApp,
} from "#shared/account";
import type { AbacusAccountInfo } from "#shared/contracts";

// Renderer cache of main's account file. `loaded` separates "nobody signed in"
// from "not read yet", so onboarding does not flash over a returning user.
interface AccountStoreState {
  account: Account | null;
  /** Read by the agent, not by the UI. */
  apps: UserApp[];
  onboarded: boolean;
  loaded: boolean;

  load: () => Promise<void>;
  /** Adopt a state main just returned, without a second read. */
  apply: (state: AccountState) => void;
  signOut: () => Promise<void>;
  /** Sign out and owe the first-run flow again. */
  forget: () => Promise<void>;
}

// Only the newest overlapping read may publish, or a slow pre-sign-out read
// resurrects the account the newer one just cleared.
let accountReadGeneration = 0;

export const useAccountStore = create<AccountStoreState>()((set) => ({
  ...EMPTY_ACCOUNT_STATE,
  loaded: false,

  load: async () => {
    const generation = ++accountReadGeneration;
    const state = await window.api.getAccountState();
    if (generation === accountReadGeneration) set({ ...state, loaded: true });
  },

  apply: (state) => {
    accountReadGeneration += 1;
    set({ ...state, loaded: true });
  },

  signOut: async () => {
    const generation = ++accountReadGeneration;
    const state = await window.api.signOutAccount();
    if (generation === accountReadGeneration) set({ ...state, loaded: true });
  },

  forget: async () => {
    const generation = ++accountReadGeneration;
    const state = await window.api.forgetAccount();
    if (generation === accountReadGeneration) set({ ...state, loaded: true });
  },
}));

/** Null when there is nobody to greet. */
export const displayName = (
  account: Account | null,
  abacusAccount?: AbacusAccountInfo | null
): string | null => {
  const name = account?.username.trim() || abacusAccount?.name?.trim();

  if (name != null && name.length > 0) return name;

  const email = account?.email.trim() || abacusAccount?.email?.trim();
  if (email == null || email.length === 0) return null;

  return email.split("@")[0] || email;
};
