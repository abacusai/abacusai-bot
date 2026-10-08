import { type } from "@orpc/contract";
import * as v from "valibot";

import type { AccountState } from "../account";
import type { AbacusAccountInfo, UsageSnapshot } from "../contracts";
import { mutation, query } from "./base";
import { NoInput } from "./ids";

export const account = {
  usage: query.input(NoInput).output(type<UsageSnapshot>()),
  /** Null when signed out. A key the platform revoked is cleared here. */
  abacus: query
    .input(v.optional(v.object({ refresh: v.optional(v.boolean()) })))
    .output(type<AbacusAccountInfo | null>()),
  /** The vault page, where the user sees and deletes saved logins and cards; null without a vault. */
  vaultUrl: query.input(NoInput).output(type<string | null>()),
  /** The account's own one-time upgrade page; null without an upgrade offer (or signed out). */
  upgradeUrl: query.input(NoInput).output(type<string | null>()),
  /** The optional local account (name and email). */
  state: query.input(NoInput).output(type<AccountState>()),
  skipOnboarding: mutation.input(NoInput).output(type<AccountState>()),
  signOut: mutation.input(NoInput).output(type<AccountState>()),
  forget: mutation.input(NoInput).output(type<AccountState>()),
};
