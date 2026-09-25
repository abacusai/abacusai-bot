/**
 * Who is owed the first-run flow.
 *
 * Two rules. Never having answered onboarding owes it: holding an Abacus.AI
 * credential is not the same as having been onboarded. And holding NO
 * credential owes it too: the app requires an account, so a sign-out (or a
 * revoked key) drops straight back onto the flow's sign-in screen.
 */
import { describe, expect, it } from "vitest";

import { resolveNeedsOnboarding } from "./app";

const resolved = {
  current: null,
  accountLoaded: true,
  credentialPending: false,
  hasAbacusCredential: true,
};

describe("nothing is usable until there is an account", () => {
  it("owes onboarding to anyone without a credential, onboarded or not", () => {
    // The wall: being onboarded once is not a licence to use the app after the
    // credential goes. A revoked key, a sign-out, a cleared field all land
    // back on the first screen.
    expect(
      resolveNeedsOnboarding({
        ...resolved,
        onboarded: true,
        hasAbacusCredential: false,
      })
    ).toBe(true);
  });

  it("says nothing while the answer is still loading", () => {
    // `null` is "not known yet", and the app is not rendered through it.
    // Otherwise a signed-out user gets a working app for the moment it takes
    // the credential to resolve.
    expect(
      resolveNeedsOnboarding({
        ...resolved,
        current: null,
        credentialPending: true,
        onboarded: true,
        hasAbacusCredential: true,
      })
    ).toBe(null);
  });
});

describe("resolveNeedsOnboarding", () => {
  it("onboards a user who has an Abacus account but has never answered", () => {
    expect(resolveNeedsOnboarding({ ...resolved, onboarded: false })).toBe(
      true
    );
  });

  it("leaves an onboarded, signed-in user alone", () => {
    expect(resolveNeedsOnboarding({ ...resolved, onboarded: true })).toBe(
      false
    );
  });

  it("walls off a signed-out user, however onboarded they once were", () => {
    expect(
      resolveNeedsOnboarding({
        ...resolved,
        hasAbacusCredential: false,
        onboarded: true,
      })
    ).toBe(true);
  });

  it("holds its answer while identity is still loading", () => {
    // The overlay must not flash over a returning user's app, so an unresolved
    // read keeps whatever was decided before rather than guessing.
    expect(
      resolveNeedsOnboarding({
        ...resolved,
        current: false,
        accountLoaded: false,
        onboarded: false,
      })
    ).toBe(false);
    expect(
      resolveNeedsOnboarding({
        ...resolved,
        current: null,
        credentialPending: true,
        onboarded: true,
      })
    ).toBe(null);
  });
});
