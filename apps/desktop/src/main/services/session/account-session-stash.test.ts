/**
 * Which folder a signed-out account's sessions wait in.
 *
 * The rule that matters: two accounts must never share one. The email is what
 * names the folder, and when it cannot be read the credential names it
 * instead — because the fallback used to be a single shared constant, which
 * meant every account whose lookup failed stashed into and restored from the
 * same place. One person signing out and another signing in under the same
 * broken condition would have handed over a whole conversation history.
 */
import { describe, expect, it } from "vitest";

import { accountStashKey, FALLBACK_ACCOUNT_KEY } from "./account-session-stash";

describe("naming an account's stash", () => {
  it("keys on the email when there is one", () => {
    expect(accountStashKey("ada@example.com")).toBe(
      accountStashKey("ada@example.com", "some-key")
    );
  });

  it("treats the same address written differently as one account", () => {
    expect(accountStashKey(" Ada@Example.com ")).toBe(
      accountStashKey("ada@example.com")
    );
  });

  it("never writes the address into the path", () => {
    expect(accountStashKey("ada@example.com")).not.toContain("ada");
    expect(accountStashKey("ada@example.com")).not.toContain("@");
  });

  it("keys on the credential when the account cannot be named", () => {
    const ada = accountStashKey(null, "key-belonging-to-ada");
    const ben = accountStashKey(null, "key-belonging-to-ben");

    // The regression this guards: both of these used to be "default", so
    // Ada's conversations came back in Ben's app.
    expect(ada).not.toBe(ben);
    expect(ada).not.toBe(FALLBACK_ACCOUNT_KEY);
  });

  it("cannot collide with an email-derived folder", () => {
    // Namespaced, so the two kinds are also told apart by a human reading the
    // tree — and a key that happens to hash like an email cannot claim it.
    expect(accountStashKey(null, "some-key")).toMatch(/^key-/);
    expect(accountStashKey("ada@example.com")).not.toMatch(/^key-/);
  });

  it("gives the same key the same folder every time", () => {
    expect(accountStashKey(null, "steady")).toBe(accountStashKey("", "steady"));
  });

  it("falls back only when there is nothing to key on at all", () => {
    // No account and no credential is nobody's data by definition.
    expect(accountStashKey(null, null)).toBe(FALLBACK_ACCOUNT_KEY);
    expect(accountStashKey(undefined)).toBe(FALLBACK_ACCOUNT_KEY);
    expect(accountStashKey("  ", "  ")).toBe(FALLBACK_ACCOUNT_KEY);
  });
});
