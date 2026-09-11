/**
 * Which account the Settings menu is talking about.
 *
 * The menu offered "Sign in" to a user who was signed in, and no way to sign
 * out at all. It read the local account file — a name and an email collected
 * during onboarding — while what a user means by "signed in" is the Abacus.AI
 * connection that mints their key. Anyone who skipped onboarding therefore had
 * no account on file, so the menu said "Sign in" no matter how connected they
 * were, and the only thing behind it cleared a profile they had never created.
 *
 * Abacus is the only provider this can apply to. Every other one is a key the
 * user pasted, and the place to remove one of those is the field it was typed
 * into — there is no session to end.
 */
import { describe, expect, it } from "vitest";

import { canSignOutOfAbacus, PROVIDER_ENV_VARS } from "./settings";

const withKeys = (
  apiKeys: Record<string, string>
): { apiKeys: Record<string, string> } => ({
  apiKeys,
});

describe("whether there is an Abacus session to end", () => {
  it("says yes when the connect flow has stored a key", () => {
    expect(canSignOutOfAbacus(withKeys({ ABACUS_API_KEY: "abacus-key" }))).toBe(
      true
    );
  });

  it("says no when nothing is stored", () => {
    expect(canSignOutOfAbacus(withKeys({}))).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("says no for %s, which is not a session", (_label, value) => {
    expect(canSignOutOfAbacus(withKeys({ ABACUS_API_KEY: value }))).toBe(false);
  });

  it("survives settings that have never been written", () => {
    expect(canSignOutOfAbacus(null)).toBe(false);
    expect(canSignOutOfAbacus({})).toBe(false);
  });

  it.each(
    Object.entries(PROVIDER_ENV_VARS).filter(
      ([provider]) => provider !== "abacus"
    )
  )(
    "ignores %s, which is a pasted key rather than a session",
    (_provider, envVar) => {
      // The regression this guards: offering to "sign out" of a provider whose
      // key the user typed in would be a confusing way to say "delete my key",
      // and there is nothing to sign out of.
      expect(canSignOutOfAbacus(withKeys({ [envVar]: "some-key" }))).toBe(
        false
      );
    }
  );

  it("is unmoved by other providers being connected alongside Abacus", () => {
    const everything = Object.fromEntries(
      Object.values(PROVIDER_ENV_VARS).map((envVar) => [envVar, "key"])
    );

    expect(canSignOutOfAbacus(withKeys(everything))).toBe(true);
  });

  it("names the key the connect flow actually writes", () => {
    // Bound to the same map the storage layer uses, so a renamed env var
    // cannot leave this checking a key nothing sets.
    expect(PROVIDER_ENV_VARS.abacus).toBe("ABACUS_API_KEY");
  });
});
