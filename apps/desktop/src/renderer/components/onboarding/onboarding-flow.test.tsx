/**
 * First run, as a user walks it: which screen each decision leads to, and
 * that every path ends in the app. Which screens a user is owed is pinned in
 * onboarding-steps.test.ts.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

// Each step stands in as a marker with its exits.
vi.mock("./connectors-step", () => ({
  ConnectorsStep: ({
    onNext,
    onBack,
  }: {
    onNext: () => void;
    onBack: () => void;
  }) => (
    <div data-id="onboarding-connectors">
      <button data-id="stub-connectors-next" onClick={onNext} />
      <button data-id="stub-connectors-back" onClick={onBack} />
    </div>
  ),
}));

vi.mock("./provider-setup-step", () => ({
  ProviderSetupStep: ({
    onDone,
    onBack,
  }: {
    onDone: () => void;
    onBack: () => void;
  }) => (
    <div data-id="onboarding-setup">
      <button data-id="stub-done" onClick={onDone} />
      <button data-id="stub-setup-back" onClick={onBack} />
    </div>
  ),
}));

vi.mock("./welcome-tour", () => ({
  WelcomeTour: ({ onFinish }: { onFinish?: () => void }) => (
    <div data-id="onboarding-explainer">
      <button data-id="stub-tour-finish" onClick={onFinish} />
    </div>
  ),
}));

const activateWorkspaceSession = vi.fn();
vi.mock("../../stores/code-store", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeWorkspaceId: "workspace-1",
      activateWorkspaceSession,
    }),
}));

const apply = vi.fn();
let onboarded = false;
vi.mock("../../stores/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({ apply, onboarded }),
}));

const startAbacusAuth = vi.fn(async () => ({ ok: true }) as const);
const cancelAbacusAuth = vi.fn(async () => undefined);
const skipAccountOnboarding = vi.fn(async () => ({ onboarded: true }));
const switchWorkspace = vi.fn(async () => undefined);
const getAbacusAccount = vi.fn(
  async () => ({ subscription_tier: null }) as { subscription_tier: unknown }
);
const listModels = vi.fn(async () => [] as unknown[]);
const addWorkspace = vi.fn(async () => ({
  success: true,
  workspaceId: "workspace-1",
}));
/** The stored keys: what "signed in" is read from. */
const getSettings = vi.fn(
  async () => ({ apiKeys: {} }) as { apiKeys: Record<string, string> }
);
const signedInSettings = { apiKeys: { ABACUS_API_KEY: "abacus-key" } };

const { OnboardingFlow } = await import("./onboarding-flow");
const { durableStorage } = await import("../../lib/durable-storage");
const { settingsQueryKeys } = await import("../../lib/settings-query-keys");

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const missing = (id: string): boolean =>
  document.querySelector(`[data-id="${id}"]`) == null;

const mount = (): QueryClient => {
  const queryClient = new QueryClient();
  render(
    (
      <QueryClientProvider client={queryClient}>
        <OnboardingFlow />
      </QueryClientProvider>
    ) as JSX.Element
  );

  return queryClient;
};

/**
 * Sign in and step past the welcome that follows. The click is retried: the
 * welcome arrives on one render and `busy` clears on the next, replacing the
 * button node.
 */
const signIn = async (): Promise<void> => {
  fireEvent.click(byId("onboarding-connect"));
  await waitFor(() => {
    fireEvent.click(byId("onboarding-welcome-continue"));
    expect(missing("onboarding-welcome-connected")).toBe(true);
  });
};

/** Sign in and click through to the explainer. */
const walkToExplainer = async (): Promise<void> => {
  await signIn();
  await waitFor(() => byId("onboarding-connectors"));
  fireEvent.click(byId("stub-connectors-next"));
  fireEvent.click(byId("stub-done"));
  await waitFor(() => byId("onboarding-explainer"));
};

beforeEach(() => {
  vi.clearAllMocks();
  onboarded = false;
  durableStorage.removeItem("onboarding.step");
  getSettings.mockResolvedValue({ apiKeys: {} });
  getAbacusAccount.mockResolvedValue({ subscription_tier: null });
  startAbacusAuth.mockResolvedValue({ ok: true });

  (globalThis.window as unknown as { api: unknown }).api = {
    skipAccountOnboarding,
    agent: {
      addWorkspace,
      getSettings,
      startAbacusAuth,
      cancelAbacusAuth,
      getAbacusAccount,
      listModels,
      switchWorkspace,
    },
  };
});

describe("the sign-in wall", () => {
  it("offers no skip: the account is the only way forward", () => {
    mount();

    expect(byId("onboarding-connect")).toBeTruthy();
    expect(missing("onboarding-skip")).toBe(true);
  });

  it("shows a failed sign-in and stays put, but says nothing of a cancelled one", async () => {
    startAbacusAuth.mockResolvedValue({
      ok: false,
      error: "nope",
    } as unknown as { ok: true });
    mount();
    fireEvent.click(byId("onboarding-connect"));

    await waitFor(() =>
      expect(byId("onboarding-error").textContent).toBe("nope")
    );

    startAbacusAuth.mockResolvedValue({
      ok: false,
      cancelled: true,
    } as unknown as { ok: true });
    fireEvent.click(byId("onboarding-connect"));

    await waitFor(() => expect(missing("onboarding-error")).toBe(true));
  });
});

describe("the sign-in that just worked", () => {
  it("moves on whatever the model catalog says about the account", async () => {
    listModels.mockResolvedValue([]);
    mount();

    fireEvent.click(byId("onboarding-connect"));

    await waitFor(() => byId("onboarding-welcome-connected"));
    expect(missing("onboarding-connect")).toBe(true);
  });

  it("is not undone by a credential read that started before it", async () => {
    let settleRead: (value: { apiKeys: Record<string, string> }) => void = () =>
      undefined;
    getSettings.mockReturnValue(
      new Promise<{ apiKeys: Record<string, string> }>((resolve) => {
        settleRead = resolve;
      })
    );
    mount();

    fireEvent.click(byId("onboarding-connect"));
    await waitFor(() => byId("onboarding-welcome-connected"));

    settleRead({ apiKeys: {} });

    await waitFor(() => byId("onboarding-welcome-connected"));
    expect(missing("onboarding-connect")).toBe(true);
  });

  it("re-reads the catalog, which changes with the credential", async () => {
    mount();
    fireEvent.click(byId("onboarding-connect"));

    await waitFor(() => expect(listModels).toHaveBeenCalledWith(true));
  });

  it("is the whole of what a returning account is asked for", async () => {
    // Signing out keeps `onboarded`, so the second sign-in of an account's
    // life must not replay the welcome, the connectors and the tour.
    onboarded = true;
    mount();

    fireEvent.click(byId("onboarding-connect"));

    await waitFor(() => expect(skipAccountOnboarding).toHaveBeenCalled());
    expect(missing("onboarding-welcome-connected")).toBe(true);
  });
});

describe("a run that already holds a credential", () => {
  it("opens past the sign-in wall it has no use for", async () => {
    getSettings.mockResolvedValue(signedInSettings);
    mount();

    await waitFor(() => byId("onboarding-welcome-connected"));
    expect(missing("onboarding-connect")).toBe(true);
  });
});

describe("losing the credential mid-flow", () => {
  it("returns to the wall, since every later screen assumes an account", async () => {
    getSettings.mockResolvedValue(signedInSettings);
    durableStorage.setItem("onboarding.step", "connectors");
    const queryClient = mount();
    await waitFor(() => byId("onboarding-connectors"));

    queryClient.setQueryData(settingsQueryKeys.models.abacusCredential, false);

    await waitFor(() => byId("onboarding-connect"));
    expect(missing("onboarding-connectors")).toBe(true);
  });
});

describe("walking the whole flow after signing in", () => {
  it("walks the connectors and the models, ends on the tour, then finishes", async () => {
    mount();
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));
    // Signing in is not finishing: nothing is recorded until the flow ends.
    expect(skipAccountOnboarding).not.toHaveBeenCalled();

    fireEvent.click(byId("stub-connectors-next"));
    expect(byId("onboarding-setup")).toBeTruthy();

    fireEvent.click(byId("stub-done"));
    await waitFor(() => byId("onboarding-explainer"));

    fireEvent.click(byId("stub-tour-finish"));
    await waitFor(() => expect(skipAccountOnboarding).toHaveBeenCalled());
    expect(apply).toHaveBeenCalledWith({ onboarded: true });
  });

  it("steps back from the models to the connectors", async () => {
    mount();
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));
    fireEvent.click(byId("stub-connectors-next"));
    expect(byId("onboarding-setup")).toBeTruthy();

    fireEvent.click(byId("stub-setup-back"));

    expect(byId("onboarding-connectors")).toBeTruthy();
  });

  it("spares a paying tier the models screen", async () => {
    getAbacusAccount.mockResolvedValue({ subscription_tier: "pro" });
    mount();
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));

    fireEvent.click(byId("stub-connectors-next"));

    await waitFor(() => byId("onboarding-explainer"));
    expect(missing("onboarding-setup")).toBe(true);
  });

  it("lands in an empty composer rather than an old chat", async () => {
    mount();
    await walkToExplainer();
    fireEvent.click(byId("stub-tour-finish"));

    await waitFor(() =>
      expect(activateWorkspaceSession).toHaveBeenCalledWith("workspace-1", null)
    );
  });

  it("does not adopt a folder on the user's behalf", async () => {
    // Opening the home directory would be a silent read/write grant over
    // everything the user owns; the composer asks instead.
    mount();
    await walkToExplainer();

    expect(addWorkspace).not.toHaveBeenCalled();
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it("ends the flow when the explainer is skipped, rather than leaving the user nowhere", async () => {
    mount();
    await walkToExplainer();

    fireEvent.click(byId("stub-tour-finish"));

    await waitFor(() => expect(skipAccountOnboarding).toHaveBeenCalled());
  });
});

describe("a renderer restarted mid-flow", () => {
  it("resumes on the step the last renderer was on", async () => {
    getSettings.mockResolvedValue(signedInSettings);
    durableStorage.setItem("onboarding.step", "connectors");
    mount();

    await waitFor(() => byId("onboarding-connectors"));
    expect(missing("onboarding-welcome-connected")).toBe(true);
  });

  it("forgets the step when the flow finishes", async () => {
    mount();
    await walkToExplainer();
    fireEvent.click(byId("stub-tour-finish"));

    await waitFor(() => expect(skipAccountOnboarding).toHaveBeenCalled());
    expect(durableStorage.getItem("onboarding.step")).toBeNull();
  });

  it("treats junk in the store as a fresh run", () => {
    durableStorage.setItem("onboarding.step", "not-a-step");
    mount();

    expect(byId("onboarding-connect")).toBeTruthy();
  });
});

describe("the sign-in screen", () => {
  it("shows what the account is for, not just what it is called", () => {
    mount();

    const overlay = byId("onboarding-overlay");

    expect(overlay.textContent).toContain("onboarding.welcomeTagline");
    for (const capability of ["Memory", "Connectors", "Models"]) {
      expect(overlay.textContent).toContain(
        `onboarding.welcomeCapability${capability}`
      );
    }
    expect(
      overlay.querySelectorAll('[data-id^="onboarding-capability-"]')
    ).toHaveLength(3);
  });

  it("answers what it costs before asking for anything", () => {
    mount();

    expect(byId("onboarding-free-badge").textContent).toContain(
      "onboarding.welcomeFreeBadge"
    );
  });
});
