/**
 * The profile dialog, from the outside: what a signed-in account shows, and
 * what a signed-out one says instead of pretending to know.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
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
const deleteAllUserData = vi.fn();

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
    deleteAllUserData,
  };
});

describe("signed in", () => {
  it("shows the account, the plan, and the month's credits — any tier", async () => {
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

/**
 * Uninstalling leaves ~/.abacusai-bot in place, and on macOS it cannot do
 * otherwise, so this control is the only way to erase it. It has to be reachable
 * and it has to be hard to hit by accident — both are asserted here.
 */
describe("deleting all data", () => {
  it("does not delete anything until the confirmation is accepted", async () => {
    getAbacusAccount.mockResolvedValue(null);
    mount();

    await waitFor(() => byId("profile-delete-all"));
    fireEvent.click(byId("profile-delete-all"));

    // The dialog is open; opening it is not consent.
    await waitFor(() => byId("profile-delete-all-confirm"));
    expect(deleteAllUserData).not.toHaveBeenCalled();

    fireEvent.click(byId("profile-delete-all-cancel"));
    expect(deleteAllUserData).not.toHaveBeenCalled();
  });

  it("deletes once the confirmation is accepted", async () => {
    getAbacusAccount.mockResolvedValue(null);
    // Main deletes and exits, so the call never settles. The button must not
    // sit waiting on a promise that will not resolve.
    deleteAllUserData.mockReturnValue(new Promise(() => {}));
    mount();

    await waitFor(() => byId("profile-delete-all"));
    fireEvent.click(byId("profile-delete-all"));
    await waitFor(() => byId("profile-delete-all-confirm"));
    fireEvent.click(byId("profile-delete-all-confirm"));

    expect(deleteAllUserData).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(byId("profile-delete-all").textContent).toContain(
        "profile.deleteAllPending"
      )
    );
  });

  it("clears what the renderer persisted, not only the files main owns", async () => {
    // ~/.abacusai-bot is main's to erase; localStorage is the renderer's, and
    // it holds the chosen language and code folder among other preferences.
    // Left behind, the relaunched app is a fresh install that still remembers
    // favourites nobody set — and it is user data the button said it would
    // delete.
    getAbacusAccount.mockResolvedValue(null);
    deleteAllUserData.mockReturnValue(new Promise(() => {}));
    window.localStorage.setItem("abacusai-bot-language", '{"language":"fr"}');
    mount();

    await waitFor(() => byId("profile-delete-all"));
    fireEvent.click(byId("profile-delete-all"));
    await waitFor(() => byId("profile-delete-all-confirm"));
    fireEvent.click(byId("profile-delete-all-confirm"));

    expect(window.localStorage.getItem("abacusai-bot-language")).toBeNull();
    expect(deleteAllUserData).toHaveBeenCalledTimes(1);
  });

  it("says the data is still there when the delete fails", async () => {
    getAbacusAccount.mockResolvedValue(null);
    deleteAllUserData.mockRejectedValue(new Error("EPERM"));
    mount();

    await waitFor(() => byId("profile-delete-all"));
    fireEvent.click(byId("profile-delete-all"));
    await waitFor(() => byId("profile-delete-all-confirm"));
    fireEvent.click(byId("profile-delete-all-confirm"));

    await waitFor(() => byId("profile-delete-all-failed"));
    // And the button comes back, rather than being stuck mid-delete.
    expect(byId("profile-delete-all").textContent).toContain(
      "profile.deleteAll"
    );
  });
});
