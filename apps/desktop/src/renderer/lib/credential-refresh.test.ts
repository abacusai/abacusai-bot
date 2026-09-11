/**
 * What a credential change is allowed to leave stale.
 *
 * The bug behind this file: the model catalog dropped its cache when a key
 * arrived and the account row did not, so signing in through onboarding left
 * the row offering "Sign in" for the rest of the session. Both read the same
 * fact; only one had been told. The list is asserted here so a cache that
 * depends on credentials cannot quietly go missing from it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  credentialQueryKeys,
  useCredentialRefresh,
} from "./credential-refresh";
import { workspaceQueryKeys } from "./query-keys";
import { settingsQueryKeys } from "./settings-query-keys";

const contains = (
  keys: readonly unknown[][],
  key: readonly unknown[]
): boolean =>
  keys.some((candidate) => JSON.stringify(candidate) === JSON.stringify(key));

describe("what an Abacus sign-in refreshes", () => {
  const keys = credentialQueryKeys("abacus");

  it("includes whether there is a session to sign out of", () => {
    // The account row's own query. This is the one that was missing.
    expect(contains(keys, settingsQueryKeys.models.abacusCredential)).toBe(
      true
    );
  });

  it("includes who is signed in", () => {
    expect(contains(keys, workspaceQueryKeys.abacusAccount)).toBe(true);
  });

  it("includes the model catalog and the settings the keys live in", () => {
    expect(contains(keys, workspaceQueryKeys.modelBots)).toBe(true);
    expect(contains(keys, workspaceQueryKeys.appSettings)).toBe(true);
    expect(contains(keys, settingsQueryKeys.models.all)).toBe(true);
  });

  it("includes the connectors that arrive with the key", () => {
    expect(contains(keys, settingsQueryKeys.connectors.all)).toBe(true);
  });
});

describe("what another provider's key refreshes", () => {
  const keys = credentialQueryKeys("openrouter");

  it("still refreshes the model catalog, which any key changes", () => {
    expect(contains(keys, workspaceQueryKeys.modelBots)).toBe(true);
    expect(contains(keys, workspaceQueryKeys.appSettings)).toBe(true);
  });

  it("leaves the Abacus-only caches alone", () => {
    // Refetching the account would be a pointless network call to Abacus for
    // a key that has nothing to do with it.
    expect(contains(keys, workspaceQueryKeys.abacusAccount)).toBe(false);
    expect(contains(keys, settingsQueryKeys.models.abacusCredential)).toBe(
      false
    );
  });

  it("names every key it returns", () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(Array.isArray(key)).toBe(true);
  });
});

describe("the subscription itself", () => {
  const mount = (): {
    emit: (event: {
      type: string;
      provider?: string;
      configured?: boolean;
    }) => void;
    invalidate: ReturnType<typeof vi.fn>;
    client: QueryClient;
    unmount: () => void;
  } => {
    let listeners: ((event: {
      type: string;
      provider?: string;
      configured?: boolean;
    }) => void)[] = [];
    (globalThis.window as unknown as { api: unknown }).api = {
      getAccountState: vi.fn(async () => ({
        account: null,
        apps: [],
        onboarded: false,
      })),
      agent: {
        onEvent: (
          listener: (event: {
            type: string;
            provider?: string;
            configured?: boolean;
          }) => void
        ) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((it) => it !== listener);
          };
        },
      },
    };

    const client = new QueryClient();
    const invalidate = vi.fn();
    client.invalidateQueries = invalidate;

    const { unmount } = renderHook(() => useCredentialRefresh(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });

    return {
      emit: (event) => {
        for (const listener of listeners) listener(event);
      },
      invalidate,
      client,
      unmount,
    };
  };

  it("drops every credential-dependent cache when a key arrives", () => {
    const { emit, invalidate } = mount();

    emit({ type: "credentials-changed", provider: "abacus" });

    expect(invalidate).toHaveBeenCalledTimes(
      credentialQueryKeys("abacus").length
    );
  });

  it("publishes sign-out to account consumers before their refetch finishes", () => {
    const { emit, client } = mount();
    client.setQueryData(settingsQueryKeys.models.abacusCredential, true);
    client.setQueryData(workspaceQueryKeys.abacusAccount, {
      name: "Previous user",
    });

    emit({
      type: "credentials-changed",
      provider: "abacus",
      configured: false,
    });

    expect(client.getQueryData(settingsQueryKeys.models.abacusCredential)).toBe(
      false
    );
    expect(client.getQueryData(workspaceQueryKeys.abacusAccount)).toBeNull();
  });

  it("ignores events that are not about credentials", () => {
    const { emit, invalidate } = mount();

    emit({ type: "session-updated" });

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("unsubscribes when the app root goes away", () => {
    const { emit, invalidate, unmount } = mount();
    unmount();

    emit({ type: "credentials-changed", provider: "abacus" });

    expect(invalidate).not.toHaveBeenCalled();
  });
});
