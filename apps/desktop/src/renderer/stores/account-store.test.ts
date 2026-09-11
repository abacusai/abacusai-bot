import { describe, expect, it, vi } from "vitest";

import type { AccountState } from "#shared/account";

import { displayName, useAccountStore } from "./account-store";

describe("displayName", () => {
  it("uses the authenticated Abacus identity when no local profile exists", () => {
    expect(
      displayName(null, {
        user_id: null,
        organization_id: null,
        name: "Ada Lovelace",
        email: "ada@example.com",
        picture: null,
        organization: null,
        org_user_count: null,
        plan: "Pro",
        subscription_tier: "pro",
        credits_used: null,
        credits_granted: null,
      })
    ).toBe("Ada Lovelace");
  });

  it("falls back to the authenticated email handle when no name is returned", () => {
    expect(
      displayName(null, {
        user_id: null,
        organization_id: null,
        name: null,
        email: "ada@example.com",
        picture: null,
        organization: null,
        org_user_count: null,
        plan: "Pro",
        subscription_tier: "pro",
        credits_used: null,
        credits_granted: null,
      })
    ).toBe("ada");
  });
});

describe("account state revalidation", () => {
  it("does not let an older read overwrite a newer signed-out state", async () => {
    const signedIn: AccountState = {
      account: {
        username: "Ada",
        email: "ada@example.com",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      apps: [],
      onboarded: true,
    };
    const signedOut: AccountState = {
      account: null,
      apps: [],
      onboarded: false,
    };
    let resolveOld!: (state: AccountState) => void;
    const oldRead = new Promise<AccountState>((resolve) => {
      resolveOld = resolve;
    });
    const getAccountState = vi
      .fn<() => Promise<AccountState>>()
      .mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce(signedOut);
    (window as unknown as { api: unknown }).api = { getAccountState };

    const first = useAccountStore.getState().load();
    const second = useAccountStore.getState().load();
    await second;
    resolveOld(signedIn);
    await first;

    expect(useAccountStore.getState()).toMatchObject({
      account: null,
      onboarded: false,
      loaded: true,
    });
  });
});
