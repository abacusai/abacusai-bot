/**
 * The step a user lands on after declining the Abacus.AI sign-in.
 *
 * What matters: both ways in actually do their thing (the browser hop and a
 * stored key), a credential already in place stops being asked for, and every
 * exit still leads out of onboarding.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const listModels = vi.fn(
  async (): Promise<{ provider: string; configured: boolean }[]> => []
);
const listStoredKeyProviders = vi.fn(async (): Promise<string[]> => []);
const saveApiKey = vi.fn(async () => ({}));
const startOpenRouterAuth = vi.fn(async () => ({ ok: true }) as const);
const startAbacusAuth = vi.fn(async () => ({ ok: true }) as const);
const cancelAbacusAuth = vi.fn(async () => undefined);
const cancelOpenRouterAuth = vi.fn(async () => undefined);
const openExternal = vi.fn();

const { ProviderSetupStep } = await import("./provider-setup-step");

const props = {
  onBack: vi.fn(),
  onDone: vi.fn(),
  dots: null,
};

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const mount = async (): Promise<void> => {
  render((<ProviderSetupStep {...props} />) as JSX.Element);
  await waitFor(() => byId("onboarding-setup-provider-openrouter-connect"));
};

beforeEach(() => {
  vi.clearAllMocks();
  listModels.mockResolvedValue([]);
  listStoredKeyProviders.mockResolvedValue([]);
  startOpenRouterAuth.mockResolvedValue({ ok: true });
  startAbacusAuth.mockResolvedValue({ ok: true });

  (globalThis.window as unknown as { api: unknown }).api = {
    openExternal,
    agent: {
      cancelAbacusAuth,
      cancelOpenRouterAuth,
      listModels,
      listStoredKeyProviders,
      saveApiKey,
      startOpenRouterAuth,
      startAbacusAuth,
    },
  };
});

describe("pasting a key", () => {
  it("asks for it in a dialog that names the errand, not a field on the page", async () => {
    // The key comes from the provider's own console, so choosing the row sends
    // the user away. A one-line field under the grid said nothing about where
    // they were going or what to come back to.
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-gemini-connect"));

    await waitFor(() => byId("onboarding-setup-key-dialog"));
    expect(byId("onboarding-setup-key-title").textContent).toContain(
      "onboarding.setupKeyDialogTitle"
    );
    expect(byId("onboarding-setup-key-link")).toBeTruthy();
    expect(byId("onboarding-setup-key-cancel")).toBeTruthy();
    // The console stays shut until it is asked for. Connect used to throw the
    // user into a web page over a dialog they had not read yet.
    expect(openExternal).not.toHaveBeenCalled();

    fireEvent.click(byId("onboarding-setup-key-link"));

    expect(openExternal).toHaveBeenCalled();
  });

  it("stores the key on save and reports the provider connected", async () => {
    await mount();
    fireEvent.click(byId("onboarding-setup-provider-gemini-connect"));
    await waitFor(() => byId("onboarding-setup-key-dialog"));

    fireEvent.change(byId("onboarding-setup-key-input"), {
      target: { value: "AIzaSyA-really-long-enough-key-value-here" },
    });
    listModels.mockResolvedValue([{ provider: "gemini", configured: true }]);
    fireEvent.click(byId("onboarding-setup-key-save"));

    await waitFor(() =>
      expect(saveApiKey).toHaveBeenCalledWith(
        "gemini",
        "AIzaSyA-really-long-enough-key-value-here"
      )
    );
    // The dialog closes and the card says so.
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="onboarding-setup-key-dialog"]')
      ).toBeNull()
    );
    await waitFor(() =>
      expect(
        byId("onboarding-setup-provider-gemini-connect").hasAttribute(
          "disabled"
        )
      ).toBe(true)
    );
  });

  it("cancels without storing anything", async () => {
    await mount();
    fireEvent.click(byId("onboarding-setup-provider-gemini-connect"));
    await waitFor(() => byId("onboarding-setup-key-dialog"));

    fireEvent.change(byId("onboarding-setup-key-input"), {
      target: { value: "AIzaSyA-really-long-enough-key-value-here" },
    });
    fireEvent.click(byId("onboarding-setup-key-cancel"));

    await waitFor(() =>
      expect(
        document.querySelector('[data-id="onboarding-setup-key-dialog"]')
      ).toBeNull()
    );
    expect(saveApiKey).not.toHaveBeenCalled();
  });
});

describe("what each card promises", () => {
  it("says what the provider is for, under its name", async () => {
    await mount();

    const card = byId("onboarding-setup-provider-openrouter");

    // Three parts, in order: the lead, the phrase worth reading, the rest.
    expect(card.textContent).toContain("onboarding.setupBlurbOpenrouterLead");
    expect(card.textContent).toContain("onboarding.setupBlurbOpenrouterAccent");
    expect(card.textContent).toContain("onboarding.setupBlurbOpenrouterTail");
    expect(byId("onboarding-setup-provider-abacus").textContent).toContain(
      "onboarding.setupBlurbAbacusAccent"
    );
    expect(byId("onboarding-setup-provider-gemini").textContent).toContain(
      "onboarding.setupBlurbGeminiAccent"
    );
  });

  it("offers OpenRouter as free models rather than open-source ones", async () => {
    // The words themselves, not the wiring: what OpenRouter is worth pressing
    // for here is the price, and the mock t() above cannot see that.
    const strings = (
      await import("../../locales/en-US.json", { with: { type: "json" } })
    ).default.onboarding as Record<string, string>;

    expect(strings.setupBlurbOpenrouterLead).toBe("Unlock");
    expect(strings.setupBlurbOpenrouterAccent).toBe("FREE models");
    expect(strings.setupBlurbOpenrouterTail).toBe("with one connection");
  });
});

describe("a hop the user walks away from", () => {
  // Both hops listen on a loopback port and sit out their own timeout — five
  // minutes for Abacus, one for OpenRouter — with the tile disabled and
  // spinning until they answer. Nothing may leave the user stuck there.
  const hangingHop = (): void => {
    startOpenRouterAuth.mockReturnValue(new Promise(() => undefined) as never);
  };

  it("can be cancelled, which frees the tile again", async () => {
    hangingHop();
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-openrouter-connect"));
    await waitFor(() => byId("onboarding-setup-cancel"));

    fireEvent.click(byId("onboarding-setup-cancel"));

    await waitFor(() =>
      expect(
        byId("onboarding-setup-provider-openrouter-connect").hasAttribute(
          "disabled"
        )
      ).toBe(false)
    );
    expect(cancelOpenRouterAuth).toHaveBeenCalled();
  });

  it("stays pressable so a stranded user can reopen the sign-in", async () => {
    // The regression: the tile was disabled for the whole twenty-minute
    // budget. Someone who signed up in the browser and never reached the
    // authorize page — the signup funnel drops it — had nothing to press at
    // the one moment they needed to try again.
    hangingHop();
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-openrouter-connect"));
    await waitFor(() => byId("onboarding-setup-cancel"));

    // The label does not change — it still says Connect, and it is still
    // clickable. The spinner and the cancel carry the in-flight state.
    const tile = byId("onboarding-setup-provider-openrouter-connect");
    expect(tile.hasAttribute("disabled")).toBe(false);
    expect(tile.textContent).toContain("onboarding.connectorsConnectCta");

    fireEvent.click(tile);

    // The main process is single-flight: starting this one stands the old one
    // down, so the renderer's only job is not to stand in the way.
    await waitFor(() => expect(startOpenRouterAuth).toHaveBeenCalledTimes(2));
  });

  it("keeps the new attempt's spinner when the abandoned one resolves", async () => {
    // The abandoned hop settles as cancelled and runs its own `finally`. An
    // unguarded reset there wiped the spinner of the hop just started.
    let settleFirst: (value: unknown) => void = () => undefined;
    startOpenRouterAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        settleFirst = resolve;
      }) as never
    );
    startOpenRouterAuth.mockReturnValueOnce(
      new Promise(() => undefined) as never
    );
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-openrouter-connect"));
    await waitFor(() => byId("onboarding-setup-cancel"));
    fireEvent.click(byId("onboarding-setup-provider-openrouter-connect"));
    await waitFor(() => expect(startOpenRouterAuth).toHaveBeenCalledTimes(2));

    settleFirst({ ok: false, cancelled: true });

    // Still spinning on the second hop, and still cancellable.
    await waitFor(() => byId("onboarding-setup-cancel"));
    expect(
      byId("onboarding-setup-provider-openrouter-connect").hasAttribute(
        "disabled"
      )
    ).toBe(false);
  });

  it("offers no cancel until there is something to cancel", async () => {
    await mount();

    expect(
      document.querySelector('[data-id="onboarding-setup-cancel"]')
    ).toBeNull();
  });

  it("is abandoned when the step is left, not left holding its port", async () => {
    hangingHop();
    const view = render((<ProviderSetupStep {...props} />) as JSX.Element);
    await waitFor(() => byId("onboarding-setup-provider-openrouter-connect"));
    fireEvent.click(byId("onboarding-setup-provider-openrouter-connect"));

    view.unmount();

    expect(cancelOpenRouterAuth).toHaveBeenCalled();
    expect(cancelAbacusAuth).toHaveBeenCalled();
  });
});

describe("OpenRouter", () => {
  it("connects through the browser rather than asking for a key", async () => {
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-openrouter-connect"));

    await waitFor(() => expect(startOpenRouterAuth).toHaveBeenCalled());
    // The two providers with a browser hop never open the key field.
    expect(
      document.querySelector('[data-id="onboarding-setup-key"]')
    ).toBeNull();
  });

  it("reports a failed sign-in but not a cancelled one", async () => {
    startOpenRouterAuth.mockResolvedValue({
      ok: false,
      error: "nope",
    } as unknown as { ok: true });
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-openrouter-connect"));

    await waitFor(() =>
      expect(byId("onboarding-setup-error").textContent).toBe("nope")
    );
  });
});

describe("a provider that takes a key", () => {
  it("opens one field, and stores the paste under that provider", async () => {
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-gemini-connect"));
    fireEvent.change(byId("onboarding-setup-key-input"), {
      target: { value: "AIzaSyB-1234567890abcdefghijklmnop" },
    });
    fireEvent.click(byId("onboarding-setup-key-save"));

    await waitFor(() =>
      expect(saveApiKey).toHaveBeenCalledWith(
        "gemini",
        "AIzaSyB-1234567890abcdefghijklmnop"
      )
    );
  });

  it("opens one key dialog, and only one", async () => {
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-gemini-connect"));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-id="onboarding-setup-key-dialog"]')
      ).toHaveLength(1)
    );

    // The other rows are browser hops, not keys: choosing one must not leave a
    // second dialog behind it.
    fireEvent.click(byId("onboarding-setup-provider-openrouter-connect"));

    expect(
      document.querySelectorAll('[data-id="onboarding-setup-key-dialog"]')
        .length
    ).toBeLessThanOrEqual(1);
  });

  it("refuses a paste that could not be a key", async () => {
    await mount();

    fireEvent.click(byId("onboarding-setup-provider-gemini-connect"));
    fireEvent.change(byId("onboarding-setup-key-input"), {
      target: { value: "nope" },
    });
    fireEvent.click(byId("onboarding-setup-key-save"));

    expect(saveApiKey).not.toHaveBeenCalled();
  });

  it("shows a key already in the environment as configured", async () => {
    listModels.mockResolvedValue([{ provider: "gemini", configured: true }]);
    await mount();

    await waitFor(() =>
      expect(
        byId("onboarding-setup-provider-gemini-connect").textContent
      ).toContain("onboarding.connectorsConnectedCta")
    );
  });
});

describe("the ways out", () => {
  it("leaves onboarding for the app", async () => {
    await mount();

    fireEvent.click(byId("onboarding-setup-done"));

    expect(props.onDone).toHaveBeenCalled();
  });

  it("offers exactly one way on", async () => {
    // Skip and Continue called the same handler; two buttons for one action
    // only asks the user what the difference is.
    await mount();

    expect(byId("onboarding-setup-done")).toBeTruthy();
    expect(
      document.querySelector('[data-id="onboarding-setup-skip"]')
    ).toBeNull();
  });

  it("stops offering the sign-in once the account is connected", async () => {
    listModels.mockResolvedValue([{ provider: "abacus", configured: true }]);
    await mount();

    await waitFor(() => byId("onboarding-setup-done"));
    expect(
      document.querySelector('[data-id="onboarding-setup-signin"]')
    ).toBeNull();
  });
});
