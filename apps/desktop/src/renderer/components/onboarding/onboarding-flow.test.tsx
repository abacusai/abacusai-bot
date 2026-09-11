import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/**
 * First run, as a user walks it.
 *
 * The flow's job is routing: which screen each decision leads to, and that
 * every path ends in the app rather than a dead end. The sign-in is a wall —
 * the app requires an account, so the first screen has no skip — while the
 * steps after it can still be stepped past. Which screens a given user is
 * owed is settled in onboarding-steps.test.ts.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

// The steps are destinations here, each standing in as a marker with its exits.
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
  ProviderSetupStep: ({ onDone }: { onDone: () => void }) => (
    <div data-id="onboarding-setup">
      <button data-id="stub-done" onClick={onDone} />
    </div>
  ),
}));

// Whether the app behind the overlay has a workspace to spotlight. The real
// hook reads the metadata query; here it is the dial each test turns.
let windowReady = true;

// The real tour spotlights the live window, which does not exist here. What
// matters to the flow is only that it ends — and that skipping ends it too.
vi.mock("./welcome-tour", () => ({
  useTourWindowReady: () => windowReady,
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
vi.mock("../../stores/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({ apply }),
}));

const anonymous: { id: string; provider: string; configured: boolean }[] = [];
const freeAccount = [
  { id: "abacus/route-llm-code-low", provider: "abacus", configured: true },
];
const subscriber = [
  ...freeAccount,
  { id: "abacus/route-llm-code", provider: "abacus", configured: true },
];

const startAbacusAuth = vi.fn(async () => ({ ok: true }) as const);
const cancelAbacusAuth = vi.fn(async () => undefined);
const skipAccountOnboarding = vi.fn(async () => ({ onboarded: true }));
const switchWorkspace = vi.fn(async () => undefined);
const getAbacusAccount = vi.fn(async () => ({ plan: "Free" }));
const listModels = vi.fn(async () => anonymous as unknown[]);
const getHomeDir = vi.fn(async () => "/Users/test");
/** The stored keys: what "signed in" is actually read from now. */
const getSettings = vi.fn(
  async () =>
    ({ apiKeys: {} }) as {
      apiKeys: Record<string, string>;
    }
);
const signedInSettings = { apiKeys: { ABACUS_API_KEY: "abacus-key" } };
const addWorkspace = vi.fn(async () => ({
  success: true,
  workspaceId: "workspace-1",
}));
/** The app's own default folder, made on the way into the tour. */

const { OnboardingFlow } = await import("./onboarding-flow");
const { durableStorage } = await import("../../lib/durable-storage");

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const missing = (id: string): boolean =>
  document.querySelector(`[data-id="${id}"]`) == null;

/**
 * Sign in and step past the welcome that now follows it. Every walk through
 * the flow crosses it, so the tests say so once here rather than in each one.
 */
const signIn = async (): Promise<void> => {
  fireEvent.click(byId("onboarding-connect"));
  // The welcome arrives on one render and `busy` clears on the next, which
  // replaces the button node — so the click is retried against whatever node
  // is current rather than one captured a render too early.
  await waitFor(() => {
    fireEvent.click(byId("onboarding-welcome-continue"));
    expect(
      document.querySelector('[data-id="onboarding-welcome-connected"]')
    ).toBeNull();
  });
};

const mount = (): void => {
  render(
    (
      <QueryClientProvider client={new QueryClient()}>
        <OnboardingFlow />
      </QueryClientProvider>
    ) as JSX.Element
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  // The step survives a renderer restart on purpose; between tests that
  // durability is just one walk leaking into the next.
  durableStorage.removeItem("onboarding.step");
  windowReady = true;
  getSettings.mockResolvedValue({ apiKeys: {} });
  navigate.mockClear();
  startAbacusAuth.mockResolvedValue({ ok: true });
  listModels.mockResolvedValue(anonymous);

  (globalThis.window as unknown as { api: unknown }).api = {
    skipAccountOnboarding,
    getHomeDir,
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
});

describe("the sign-in that just worked", () => {
  it("survives a model catalog that does not mention the account yet", async () => {
    // "Signed in" used to mean "an Abacus model came back configured", which
    // is a question about the platform rather than about the account: a slow
    // reply, a failed one, or an empty list on a just-created account all read
    // as signed out. The flow advanced and was thrown straight back onto the
    // wall it had just cleared — the screen flashing once, right after a
    // sign-in that had in fact worked.
    listModels.mockResolvedValue(anonymous);
    mount();

    fireEvent.click(byId("onboarding-connect"));

    await waitFor(() => byId("onboarding-welcome-connected"));
    expect(missing("onboarding-connect")).toBe(true);
  });

  it("is not undone by a credential read that started before it", async () => {
    // The read is issued before the key exists, so its answer can land after
    // the hop has already stored one. That stale "signed out" must not count.
    let settleRead: (value: { apiKeys: Record<string, string> }) => void = () =>
      undefined;
    getSettings.mockReturnValue(
      new Promise<{ apiKeys: Record<string, string> }>((resolve) => {
        settleRead = resolve;
      })
    );
    listModels.mockResolvedValue(freeAccount);
    mount();

    fireEvent.click(byId("onboarding-connect"));
    await waitFor(() => byId("onboarding-welcome-connected"));

    settleRead({ apiKeys: {} });

    await waitFor(() => byId("onboarding-welcome-connected"));
    expect(missing("onboarding-connect")).toBe(true);
  });
});

describe("a run that already holds a credential", () => {
  it("opens past the sign-in wall it has no use for", async () => {
    // The wall has no skip, and everything it offers is already done — so
    // opening on it is a dead end. The route omits the screen (stepsFor);
    // the flow has to agree with it.
    getSettings.mockResolvedValue(signedInSettings);
    listModels.mockResolvedValue(freeAccount);
    mount();

    await waitFor(() => byId("onboarding-welcome-connected"));
    expect(missing("onboarding-connect")).toBe(true);
  });
});

describe("walking the whole flow after signing in", () => {
  const signIn = async (): Promise<void> => {
    listModels.mockResolvedValue(freeAccount);
    mount();
    fireEvent.click(byId("onboarding-connect"));
    // The account's welcome now stands between signing in and the setup steps.
    // The click is retried against the current node: the welcome arrives on one
    // render and `busy` clears on the next, replacing the button underneath.
    await waitFor(() => {
      fireEvent.click(byId("onboarding-welcome-continue"));
      expect(
        document.querySelector('[data-id="onboarding-welcome-connected"]')
      ).toBeNull();
    });
  };

  it("walks the connectors and the models, ends on the tour, then finishes", async () => {
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

  it("lands in an empty composer rather than an old chat", async () => {
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));
    fireEvent.click(byId("stub-connectors-next"));
    fireEvent.click(byId("stub-done"));
    await waitFor(() => byId("onboarding-explainer"));
    fireEvent.click(byId("stub-tour-finish"));

    // Setup ends with the user about to say the first thing they want done;
    // a transcript from last week would bury that behind old context.
    await waitFor(() =>
      expect(activateWorkspaceSession).toHaveBeenCalledWith("workspace-1", null)
    );
    // And on the composer, not on whichever Settings page the tour's last
    // spotlight happened to leave the router pointing at.
  });
});

describe("with no workspace yet (a fresh install, or after Delete all data)", () => {
  // The explainer drops the overlay and spotlights the live window. With no
  // workspace the app underneath is the full-page folder-setup screen, so the
  // tour must wait for the folder step to make the window real.
  it("does not start the tour over the folder-setup page", async () => {
    windowReady = false;
    listModels.mockResolvedValue(freeAccount);
    mount();

    await signIn();

    await waitFor(() => byId("onboarding-connectors"));
    expect(missing("onboarding-explainer")).toBe(true);
  });

  it("does not adopt a folder on the user's behalf", async () => {
    // Setup used to open the user's home directory on the way out, so the app
    // always had a workspace and the tour always had a target. That is read
    // and write of everything the user owns, granted silently to save a
    // question. Choosing where the work happens is the whole of what a session
    // is for, so the composer asks — and the tour does not need an answer.
    windowReady = false;
    listModels.mockResolvedValue(freeAccount);
    mount();
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));
    fireEvent.click(byId("stub-connectors-next"));
    fireEvent.click(byId("stub-done"));

    await waitFor(() => byId("onboarding-explainer"));
    expect(addWorkspace).not.toHaveBeenCalled();
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it("tours with no folder open, because no stop needs one", async () => {
    // The regression: the tour was gated on a workspace existing, and with no
    // folder the explainer was dropped from the route — permanently, since
    // this flow is the only thing that opens the tour and nothing re-armed it
    // when a folder appeared later. The gate was stricter than the stops: they
    // point at the sidebar, the connectors nav, and the bot maker, none of
    // which need a workspace.
    windowReady = false;
    listModels.mockResolvedValue(freeAccount);
    mount();
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));
    fireEvent.click(byId("stub-connectors-next"));
    fireEvent.click(byId("stub-done"));

    await waitFor(() => byId("onboarding-explainer"));
  });
});

describe("when the home directory cannot even be read", () => {
  it("does not care, because it no longer asks", async () => {
    // This used to be a real hazard: adopting a folder happened on the way
    // into the last step, so an exception there took the step transition with
    // it and Continue simply stopped working. Nothing reads the home
    // directory during setup any more.
    windowReady = false;
    getHomeDir.mockRejectedValue(new Error("EACCES"));
    listModels.mockResolvedValue(freeAccount);
    mount();
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));
    fireEvent.click(byId("stub-connectors-next"));

    fireEvent.click(byId("stub-done"));

    await waitFor(() => byId("onboarding-explainer"));
    expect(getHomeDir).not.toHaveBeenCalled();
  });
});

describe("skipping the explainer", () => {
  it("ends the flow rather than leaving the user nowhere", async () => {
    // The tour reports skip and finish the same way, and it is the last step —
    // so both must land in the app, with onboarding recorded as done.
    listModels.mockResolvedValue(freeAccount);
    mount();
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));
    fireEvent.click(byId("stub-connectors-next"));
    fireEvent.click(byId("stub-done"));
    await waitFor(() => byId("onboarding-explainer"));

    fireEvent.click(byId("stub-tour-finish"));

    await waitFor(() => expect(skipAccountOnboarding).toHaveBeenCalled());
  });
});

describe("signing in", () => {
  it("goes on to the connectors the account just bought", async () => {
    listModels.mockResolvedValue(freeAccount);
    mount();
    await signIn();

    await waitFor(() => byId("onboarding-connectors"));
    expect(skipAccountOnboarding).not.toHaveBeenCalled();
  });

  it("shows a subscriber the models step too, rather than ending the flow", async () => {
    // The regression: dropping this step for a paid account turned "skip" on
    // the connectors page into "leave onboarding".
    listModels.mockResolvedValue(subscriber);
    mount();
    await signIn();

    await waitFor(() => byId("onboarding-connectors"));
    fireEvent.click(byId("stub-connectors-next"));

    expect(byId("onboarding-setup")).toBeTruthy();
    expect(skipAccountOnboarding).not.toHaveBeenCalled();
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

/**
 * The renderer does not live as long as onboarding does: an experience swap
 * replaces it and crash recovery reloads it, usually while the user is off
 * scanning a QR. The step has to come back where the user was, not on the
 * welcome screen — and it has to be forgotten once the flow ends, or a rerun
 * from Settings would open in the middle.
 */
describe("a renderer restarted mid-flow", () => {
  it("resumes on the step the last renderer was on", async () => {
    getSettings.mockResolvedValue(signedInSettings);
    listModels.mockResolvedValue(freeAccount);
    durableStorage.setItem("onboarding.step", "connectors");
    mount();

    await waitFor(() => byId("onboarding-connectors"));
    expect(missing("onboarding-welcome-connected")).toBe(true);
  });

  it("forgets the step when the flow finishes", async () => {
    listModels.mockResolvedValue(freeAccount);
    mount();
    await signIn();
    await waitFor(() => byId("onboarding-connectors"));
    fireEvent.click(byId("stub-connectors-next"));
    fireEvent.click(byId("stub-done"));
    await waitFor(() => byId("onboarding-explainer"));
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

/**
 * What the first screen says before asking for an account.
 *
 * The old screen described the offer in one paragraph and asked for a sign-in
 * under it. These are the three claims that paragraph was burying.
 */
describe("the sign-in screen", () => {
  it("shows what the account is for, not just what it is called", () => {
    mount();

    const overlay = byId("onboarding-overlay");

    expect(overlay.textContent).toContain("onboarding.welcomeTagline");
    // Three headlines, one per thing worth knowing before signing up.
    for (const capability of ["Memory", "Connectors", "Models"]) {
      expect(overlay.textContent).toContain(
        `onboarding.welcomeCapability${capability}`
      );
    }
    expect(
      overlay.querySelectorAll('[data-id^="onboarding-capability-"]')
    ).toHaveLength(3);
  });

  it("answers the question a sign-in prompt raises, before it is asked", () => {
    // What it costs is the first thing anyone wants to know, and it is on the
    // screen before the button that asks them to commit to anything.
    mount();

    expect(byId("onboarding-free-badge").textContent).toContain(
      "onboarding.welcomeFreeBadge"
    );
  });
});
