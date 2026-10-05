/**
 * The local account: a name and email kept in `~/.abacusai-bot/account.json`
 * to personalise the app. It authenticates nothing, so it is optional, always
 * skippable, and nothing in the app may be gated on it.
 */

/** An app the user says they work in day to day. */
export interface UserApp {
  /** A `ConnectorDefinition.id`. */
  id: string;
  /** The catalog's display name, copied so the agent needn't know the catalog. */
  name: string;
}

export interface Account {
  /** Display name, shown in the greeting. Free-form. */
  username: string;
  email: string;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * What the renderer sees. `onboarded` is true once the user has given their
 * details or explicitly skipped, and suppresses the first-run flow after that.
 */
export interface AccountState {
  account: Account | null;
  /** Onboarding does not ask any more; kept because old accounts carry it and the agent reads it. */
  apps: UserApp[];
  onboarded: boolean;
}

export const EMPTY_ACCOUNT_STATE: AccountState = {
  account: null,
  apps: [],
  onboarded: false,
};
