import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/**
 * The Settings menu's account row, from the outside.
 *
 * It offered "Sign in" to somebody who was already signed in, and no way to
 * sign out. The row read the local account file — a name and an email collected
 * during onboarding — while what a user means by "signed in" is the Abacus.AI
 * connection that mints their key. Skipping onboarding leaves no account on
 * file, so the row said "Sign in" however connected you were, and the only
 * action behind it cleared a profile that had never been created.
 *
 * The rule itself is unit-tested next to the settings type. What is pinned here
 * is the wiring, because reading the wrong piece of state is exactly what went
 * wrong: this renders the menu against a stored Abacus key and checks the row
 * follows it.
 */
import { render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());

// The menu renders translated strings; the keys are what the assertions read.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let pathname = "/";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname } }),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock("../../hooks/use-theme", () => ({
  useTheme: () => ({
    theme: "system",
    effectiveTheme: "light",
    setTheme: vi.fn(),
  }),
}));

vi.mock("../../stores/language-store", () => ({
  useLanguageStore: (selector: (state: unknown) => unknown) =>
    selector({ languageCode: "en", setLanguageCode: vi.fn() }),
}));

const signOutAccount = vi.fn();
const forgetAccount = vi.fn();

// No account on file — the state anyone who skipped onboarding is in, and the
// one that produced the bug.
vi.mock("../../stores/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({ account: null, signOut: signOutAccount, forget: forgetAccount }),
  displayName: (
    account: { username?: string } | null,
    abacus?: { name?: string | null } | null
  ) => account?.username?.trim() || abacus?.name?.trim() || null,
}));

const saveApiKey = vi.fn<(provider: string, key: string) => void>();
/** Subscribers to the agent event stream, so unsubscribing has something real. */
let eventListeners: ((event: { type: string; provider?: string }) => void)[] =
  [];

const listModels = vi.fn(async () => []);
const removeMcpServer = vi.fn(async () => ({ success: true }));
const signOutAbacus = vi.fn(async (_options: { keepOtherApiKeys: boolean }) => {
  delete storedKeys.ABACUS_API_KEY;
  return { stashedSessions: 0, removedProviders: [] };
});
let storedKeys: Record<string, string> = {};

const { SettingsMenu } = await import("./settings-menu");

// The app tags nodes with `data-id`, not `data-testid`.
const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const mountMenu = async (): Promise<void> => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    (
      <QueryClientProvider client={client}>
        <SettingsMenu />
      </QueryClientProvider>
    ) as JSX.Element
  );
  // The row lives behind the trigger, and the Abacus state is read on open.
  byId("settings-menu-trigger").click();
  await waitFor(() => expect(byId("settings-menu-sign-out")).toBeTruthy());
};

const accountRowLabel = (): string =>
  byId("settings-menu-sign-out").textContent ?? "";

beforeEach(() => {
  storedKeys = {};
  saveApiKey.mockClear();
  listModels.mockClear();
  removeMcpServer.mockClear();
  signOutAbacus.mockClear();
  signOutAccount.mockClear();
  forgetAccount.mockClear();
  navigate.mockClear();
  eventListeners = [];

  // AboutDialog reads versions off the preload's electron bridge at mount.
  // Narrowed to what the menu's subtree touches.
  (globalThis.window as any).electron = {
    process: { versions: { electron: "0", chrome: "0", node: "0" } },
  };

  // The preload bridge, narrowed to what the menu's subtree reaches for on
  // mount. The dialogs it renders are incidental to the account row; they only
  // need to not throw, so this is a deliberate subset of the real surface.
  (globalThis.window as any).api = {
    getAppVersion: async () => "0.0.0-test",
    agent: {
      getSettings: async () => ({ apiKeys: storedKeys }),
      saveApiKey: async (provider: string, key: string) => {
        saveApiKey(provider, key);
        if (key.trim().length === 0) delete storedKeys.ABACUS_API_KEY;

        return { apiKeys: storedKeys };
      },
      listModels,
      removeMcpServer,
      signOutAbacus,
      onEvent: (
        listener: (event: { type: string; provider?: string }) => void
      ) => {
        eventListeners.push(listener);
        return () => {
          eventListeners = eventListeners.filter((it) => it !== listener);
        };
      },
      getAbacusAccount: async () =>
        storedKeys.ABACUS_API_KEY == null
          ? null
          : { name: "Ada", email: "ada@example.com" },
    },
  };
});

describe("the account row", () => {
  it("offers to sign out when Abacus is connected", async () => {
    // The report: signed in, and the row said "Sign in".
    storedKeys = { ABACUS_API_KEY: "abacus-key" };

    await mountMenu();

    await waitFor(() =>
      expect(accountRowLabel()).toContain("userMenu.signOut")
    );
    expect(byId("settings-menu-trigger-name").textContent).toBe("Ada");
  });

  it("offers to sign in when nothing is connected", async () => {
    await mountMenu();

    await waitFor(() => expect(accountRowLabel()).toContain("userMenu.signIn"));
  });

  it("is not fooled by another provider being configured", async () => {
    // A pasted OpenAI key is not a session, so there is nothing to sign out of.
    storedKeys = { OPENAI_API_KEY: "sk-test" };

    await mountMenu();

    await waitFor(() => expect(accountRowLabel()).toContain("userMenu.signIn"));
  });

  it("signs out in one sweep: sessions stashed, every key deleted, no dialog", async () => {
    // The whole sweep is main's (SignOutAbacus); the renderer never touches
    // the keys itself, and there is no choice to make — the other keys go too.
    storedKeys = { ABACUS_API_KEY: "abacus-key", OPENAI_API_KEY: "sk-test" };
    await mountMenu();
    await waitFor(() =>
      expect(accountRowLabel()).toContain("userMenu.signOut")
    );

    byId("settings-menu-sign-out").click();

    await waitFor(() =>
      expect(signOutAbacus).toHaveBeenCalledWith({ keepOtherApiKeys: false })
    );
    expect(signOutAccount).toHaveBeenCalled();
    expect(saveApiKey).not.toHaveBeenCalled();
    expect(removeMcpServer).not.toHaveBeenCalled();
    expect(document.querySelector('[data-id="sign-out-dialog"]')).toBeNull();
  });

  it("forgets the local account outright when there is no session to end", async () => {
    // This is what puts the first-run flow back for somebody who skipped
    // onboarding — the full forget, not a sign-out, which now keeps the
    // onboarded answer for the account's return.
    await mountMenu();
    await waitFor(() => expect(accountRowLabel()).toContain("userMenu.signIn"));

    byId("settings-menu-sign-out").click();

    await waitFor(() => expect(forgetAccount).toHaveBeenCalled());
    expect(signOutAccount).not.toHaveBeenCalled();
    expect(signOutAbacus).not.toHaveBeenCalled();
  });
});

describe("the memory button beside the account", () => {
  it("opens the memory page without opening the account menu", async () => {
    // Its own control, next to the name rather than inside the menu: what the
    // agent remembers is one of the few settings pages people come back to.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      (
        <QueryClientProvider client={client}>
          <SettingsMenu />
        </QueryClientProvider>
      ) as JSX.Element
    );

    byId("settings-menu-memory").click();

    expect(navigate).toHaveBeenCalledWith({ to: "/settings/memory" });
    // A control nested inside the trigger would have opened the menu on the
    // way past.
    expect(document.querySelector('[data-id="settings-menu"]')).toBeNull();
  });

  it("marks itself while the memory page is the one on screen", () => {
    // The button is the only way back out of the memory page, so it has to say
    // when you are already on it — otherwise it reads as a place you have not
    // been.
    pathname = "/settings/memory";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      (
        <QueryClientProvider client={client}>
          <SettingsMenu />
        </QueryClientProvider>
      ) as JSX.Element
    );

    expect(byId("settings-menu-memory").getAttribute("aria-current")).toBe(
      "page"
    );
    expect(byId("settings-menu-memory").hasAttribute("data-active")).toBe(true);
    pathname = "/";
  });
});

describe("settings routes", () => {
  it("opens MCP management in the focused settings family", async () => {
    await mountMenu();

    byId("settings-menu-mcp").click();

    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/mcp",
    });
  });
});
