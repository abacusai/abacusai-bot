/**
 * The profile dialog, from the outside: what a signed-in account shows, and
 * what a signed-out one says instead of pretending to know.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}:${Object.values(vars).join("/")}` : key,
  }),
}));

let localAccount: { username: string; email: string } | null = null;
vi.mock("../../stores/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({ account: localAccount }),
  displayName: (
    account: { username?: string } | null,
    remote?: { name?: string | null } | null
  ) => account?.username?.trim() || remote?.name?.trim() || null,
}));

const getAbacusAccount = vi.fn();

const { ProfilePanel } = await import("./profile-panel");

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const mount = (): void => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    (
      <QueryClientProvider client={client}>
        <ProfilePanel />
      </QueryClientProvider>
    ) as JSX.Element
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  localAccount = null;
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: { getAbacusAccount },
  };
});

describe("signed in", () => {
  it("shows the account, the plan, and the month's credits on any tier", async () => {
    getAbacusAccount.mockResolvedValue({
      name: "Ada",
      email: "ada@example.com",
      picture: "data:image/png;base64,AQID",
      organization: "ada-org",
      org_user_count: 1,
      plan: "Free",
      subscription_tier: "free",
      credits_used: 128,
      credits_granted: 2000,
    });
    mount();

    await waitFor(() => byId("profile-plan"));
    expect(byId("profile-plan").textContent).toBe("Free");
    expect(byId("profile-name").textContent).toBe("Ada");
    expect(byId("profile-organization").textContent).toBe("ada-org");
    expect(byId("profile-credits").textContent).toContain("128/2,000");
  });

  it("prefers the local account's name over the server's", async () => {
    localAccount = { username: "Local Name", email: "local@example.com" };
    getAbacusAccount.mockResolvedValue({
      name: "Server Name",
      email: "server@example.com",
      picture: null,
      organization: null,
      org_user_count: null,
      plan: "Pro",
      subscription_tier: "pro",
      credits_used: 0,
      credits_granted: 25000,
    });
    mount();

    await waitFor(() => byId("profile-plan"));
    expect(byId("profile-name").textContent).toBe("Local Name");
    expect(byId("profile-email").textContent).toBe("local@example.com");
  });

  it("shows a connected Abacus account when profile fields are private", async () => {
    getAbacusAccount.mockResolvedValue({
      name: null,
      email: null,
      picture: null,
      organization: null,
      org_user_count: null,
      plan: null,
      subscription_tier: null,
      credits_used: null,
      credits_granted: null,
    });
    mount();

    await waitFor(() =>
      expect(byId("profile-name").textContent).toBe("profile.connectedAccount")
    );
    expect(document.querySelector('[data-id="profile-signed-out"]')).toBeNull();
  });
});

describe("signed out", () => {
  it("names the state rather than the person, and says there is no Abacus session", async () => {
    getAbacusAccount.mockResolvedValue(null);
    mount();

    await waitFor(() => byId("profile-signed-out"));
    expect(byId("profile-name").textContent).toBe("profile.notSignedInShort");
  });
});
