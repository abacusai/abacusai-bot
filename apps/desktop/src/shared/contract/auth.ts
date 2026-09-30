import { type } from "@orpc/contract";
import * as v from "valibot";

import type {
  AbacusAuthOutcome,
  AbacusSignOutResult,
  BrowserSignInProfile,
  OpenRouterAuthOutcome,
} from "../contracts";
import { mutation, query } from "./base";
import { NoInput } from "./ids";

/**
 * Browser sign-ins. Each `start` resolves when the user finishes, cancels or
 * it times out; the outcome union (with `cancelled`) is what the UI branches
 * on, so it stays an output rather than an error.
 */
export const auth = {
  openRouter: {
    start: mutation.input(NoInput).output(type<OpenRouterAuthOutcome>()),
    cancel: mutation.input(NoInput).output(type<void>()),
  },
  abacus: {
    start: mutation
      .input(
        v.optional(
          v.object({
            intent: v.optional(v.picklist(["signup", "signin"])),
            browserProfileId: v.optional(v.string()),
          })
        )
      )
      .output(type<AbacusAuthOutcome>()),
    /** Chromium profiles offered as "Continue with …". */
    browserProfiles: query
      .input(NoInput)
      .output(type<BrowserSignInProfile[]>()),
    cancel: mutation.input(NoInput).output(type<void>()),
    /** Move an in-flight sign-in from the app window to the browser. */
    openInBrowser: mutation.input(NoInput).output(type<void>()),
    /** Stashes this account's sessions; other keys go too unless kept. */
    signOut: mutation
      .input(v.object({ keepOtherApiKeys: v.boolean() }))
      .output(type<AbacusSignOutResult>()),
  },
};
