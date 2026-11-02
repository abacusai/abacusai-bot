import { type } from "@orpc/contract";
import * as v from "valibot";

import type { AccountState } from "../account";
import { type BillingPlan, UPGRADE_SRCS } from "../billing-plan";
import type {
  AbacusAccountInfo,
  AbacusPaymentRequired,
  UsageSnapshot,
} from "../contracts";
import { mutation, query } from "./base";
import { NoInput } from "./ids";

export const account = {
  usage: query.input(NoInput).output(type<UsageSnapshot>()),
  /** Null when signed out. A key the platform revoked is cleared here. */
  abacus: query
    .input(v.optional(v.object({ refresh: v.optional(v.boolean()) })))
    .output(type<AbacusAccountInfo | null>()),
  /**
   * Null unless the platform's payment gate refuses the account (a sign-in
   * held until it pays, or the stored key). `refresh` asks again; a held
   * sign-in that now passes is signed in, and this answers null.
   */
  payment: query
    .input(v.optional(v.object({ refresh: v.optional(v.boolean()) })))
    .output(type<AbacusPaymentRequired | null>()),
  /** Drop the sign-in held for payment, or sign out the account that must pay. */
  releasePayment: mutation.input(NoInput).output(type<void>()),
  /** The vault page, where the user sees and deletes saved logins and cards; null without a vault. */
  vaultUrl: query.input(NoInput).output(type<string | null>()),
  /**
   * The account's own upgrade page, tagged with the screen it is opened from
   * (`app` when none is given); null without an upgrade offer (or signed out).
   */
  upgradeUrl: query
    .input(v.optional(v.object({ src: v.optional(v.picklist(UPGRADE_SRCS)) })))
    .output(type<string | null>()),
  /**
   * The account's plan, credits and upgrades as the platform reads them now,
   * for the credit wall's card; null signed out or when the call fails.
   */
  billingPlan: query.input(NoInput).output(type<BillingPlan | null>()),
  /** The optional local account (name and email). */
  state: query.input(NoInput).output(type<AccountState>()),
  skipOnboarding: mutation.input(NoInput).output(type<AccountState>()),
  signOut: mutation.input(NoInput).output(type<AccountState>()),
  forget: mutation.input(NoInput).output(type<AccountState>()),
};
