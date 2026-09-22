/**
 * The card standing where a turn died for want of credits. The free tier is
 * offered the free sources it has not connected, never a plan; once a source
 * joins, the dead turn is run again. A paid tier is pointed at its top-up.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AbacusAccountInfo } from "#shared/contracts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

const account = vi.hoisted(() => ({
  current: null as AbacusAccountInfo | null,
}));
const providers = vi.hoisted(() => ({
  configured: {} as Record<string, boolean>,
}));

vi.mock("../../hooks/use-abacus-account", () => ({
  useAbacusAccountQuery: () => ({ data: account.current, dataUpdatedAt: 0 }),
}));
vi.mock("../../hooks/use-model-providers", () => ({
  useModelProvidersQuery: () => ({
    data: { configured: providers.configured, stored: new Set() },
  }),
}));

const localModels = vi.hoisted(() => ({ runtimeAvailable: true }));
vi.mock("../../hooks/use-local-models", () => ({
  useLocalModels: () => ({
    state: {
      runtimeAvailable: localModels.runtimeAvailable,
      totalMemoryBytes: 0,
      recommendedId: "qwen3.5-4b",
      catalog: [],
      installedIds: [],
      download: null,
      servingId: null,
    },
  }),
}));

const {
  PremiumUpgradeCard,
  exhaustedScope,
  freeModelSwitches,
  wantsUpgradeCard,
} = await import("./premium-upgrade-card");
const { useLocalModelDialogStore } =
  await import("../../stores/local-model-dialog-store");
const { useCreditsStore } = await import("../../stores/credits-store");

const free = (over: Partial<AbacusAccountInfo> = {}): AbacusAccountInfo => ({
  user_id: "u1",
  organization_id: "o1",
  name: "Ada",
  email: "ada@example.com",
  picture: null,
  organization: null,
  org_user_count: null,
  plan: "Free",
  subscription_tier: "free",
  credits_used: 100,
  credits_granted: 100,
  ...over,
});

const startOpenRouterAuth = vi.fn(async () => ({ ok: true as const }));
const listModels = vi.fn(async () => []);
const openExternal = vi.fn();

const renderCard = (props: Parameters<typeof PremiumUpgradeCard>[0]) =>
  render(
    (
      <QueryClientProvider client={new QueryClient()}>
        <PremiumUpgradeCard {...props} />
      </QueryClientProvider>
    ) as JSX.Element
  );

const button = (suffix: string) =>
  document.querySelector<HTMLButtonElement>(
    `[data-id="chat-upgrade-card-${suffix}"]`
  );

beforeEach(() => {
  localStorage.clear();
  useCreditsStore.setState({ exhaustedAt: null });
  useLocalModelDialogStore.setState({ open: false, onReady: null });
  account.current = free();
  providers.configured = { abacus: true };
  navigate.mockClear();
  startOpenRouterAuth.mockClear();
  listModels.mockClear();
  openExternal.mockClear();
  Object.assign(window, {
    api: { agent: { startOpenRouterAuth, listModels }, openExternal },
  });
});

afterEach(cleanup);

describe("PremiumUpgradeCard", () => {
  it("marks the credits exhausted the moment it stands in the chat", () => {
    renderCard({ dataId: "chat-upgrade-card" });
    expect(useCreditsStore.getState().exhaustedAt).not.toBeNull();
  });

  it("offers the free tier the sources it has not connected, and no plan", () => {
    renderCard({ dataId: "chat-upgrade-card" });

    expect(button("connect-openrouter")).not.toBeNull();
    expect(button("connect-gemini")).not.toBeNull();
    expect(button("cta")).toBeNull();
    expect(document.body.textContent).toContain(
      "workspace.premiumUpgrade.connectNote"
    );
  });

  it("offers only the source still missing", () => {
    providers.configured = { abacus: true, openrouter: true };
    renderCard({ dataId: "chat-upgrade-card" });

    expect(button("connect-openrouter")).toBeNull();
    expect(button("connect-gemini")).not.toBeNull();
  });

  it("runs the dead turn again once OpenRouter is connected", async () => {
    const onResume = vi.fn();
    renderCard({ dataId: "chat-upgrade-card", onResume });

    fireEvent.click(button("connect-openrouter")!);

    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(startOpenRouterAuth).toHaveBeenCalledTimes(1);
    // The catalog is re-read before the retry, so the pool has the new models.
    expect(listModels).toHaveBeenCalledWith(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leaves the turn alone when the sign-in was cancelled", async () => {
    startOpenRouterAuth.mockResolvedValueOnce({
      ok: false,
      error: "closed",
      cancelled: true,
    } as never);
    const onResume = vi.fn();
    renderCard({ dataId: "chat-upgrade-card", onResume });

    fireEvent.click(button("connect-openrouter")!);

    await waitFor(() => expect(startOpenRouterAuth).toHaveBeenCalled());
    expect(onResume).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("asks for Google's key here, without leaving the card", () => {
    // Google has no sign-in hop, only a paste. Sending the user to Settings
    // abandoned the turn that raised this card; the dialog carries the link.
    renderCard({ dataId: "chat-upgrade-card" });

    fireEvent.click(button("connect-gemini")!);

    expect(
      document.querySelector('[data-id="provider-key-dialog"]')
    ).not.toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("offers a local model once every free source is connected, and resumes on it", () => {
    providers.configured = { abacus: true, openrouter: true, gemini: true };
    const onPickModel = vi.fn();
    const onResume = vi.fn();
    renderCard({ dataId: "chat-upgrade-card", onPickModel, onResume });

    expect(button("connect-openrouter")).toBeNull();
    expect(button("cta")).toBeNull();
    expect(document.body.textContent).toContain(
      "workspace.premiumUpgrade.localNote"
    );
    fireEvent.click(button("local")!);
    expect(useLocalModelDialogStore.getState().open).toBe(true);

    // The dialog reports the model ready: the chat moves onto it and runs on.
    useLocalModelDialogStore.getState().onReady?.("local/qwen3.5-4b");
    expect(onPickModel).toHaveBeenCalledWith("local/qwen3.5-4b");
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("points at the picker instead on a build without the local runtime", () => {
    providers.configured = { abacus: true, openrouter: true, gemini: true };
    localModels.runtimeAvailable = false;
    const onSwitchModel = vi.fn();
    renderCard({ dataId: "chat-upgrade-card", onSwitchModel });
    localModels.runtimeAvailable = true;

    expect(button("local")).toBeNull();
    expect(document.body.textContent).toContain(
      "workspace.premiumUpgrade.switchNote"
    );
    fireEvent.click(button("switch")!);
    expect(onSwitchModel).toHaveBeenCalledTimes(1);
  });

  it("still offers the platform's free models by name", () => {
    const onPickModel = vi.fn();
    renderCard({
      dataId: "chat-upgrade-card",
      freeModels: [{ model: "abacus/x", label: "X" }],
      onPickModel,
    });

    fireEvent.click(button("free-model")!);
    expect(onPickModel).toHaveBeenCalledWith("abacus/x");
  });

  it("sends a paid tier to its top-up, not to a free source", () => {
    account.current = free({ subscription_tier: "pro" });
    renderCard({ dataId: "chat-upgrade-card" });

    expect(button("connect-openrouter")).toBeNull();
    fireEvent.click(button("cta")!);
    expect(openExternal).toHaveBeenCalledWith(
      "https://apps.abacus.ai/chatllm/admin/profile?buyCredits=true"
    );
  });
});

describe("what the card says ran out", () => {
  it("wants the card for a shut pool too, titled for it", () => {
    expect(wantsUpgradeCard([{ type: "free-pool-out" }])).toBe(true);
    expect(exhaustedScope([{ type: "free-pool-out" }])).toBe("pool");
    expect(exhaustedScope([{ type: "upgrade-abacus" }])).toBe("abacus");
    expect(exhaustedScope([{ type: "switch-model" }])).toBe("pool");

    renderCard({ dataId: "chat-upgrade-card", scope: "pool" });
    expect(document.body.textContent).toContain(
      "workspace.premiumUpgrade.poolOutTitle"
    );
    expect(button("connect-openrouter")).not.toBeNull();
  });
});

describe("the upgrade card's free-model switches", () => {
  it("offers each named switch-model action, labelled", () => {
    expect(
      freeModelSwitches([
        { type: "upgrade-abacus", link: "https://example.invalid/plan" },
        {
          type: "switch-model",
          model: "abacus/stealth/union-alpha",
          label: "Union Alpha",
        },
      ])
    ).toEqual([{ model: "abacus/stealth/union-alpha", label: "Union Alpha" }]);
  });

  it("ignores the bare switch action, which only opens the picker", () => {
    expect(freeModelSwitches([{ type: "switch-model" }])).toEqual([]);
    expect(freeModelSwitches(undefined)).toEqual([]);
  });

  it("still wants the card when switches ride along", () => {
    expect(
      wantsUpgradeCard([
        { type: "upgrade-abacus" },
        { type: "switch-model", model: "abacus/x" },
      ])
    ).toBe(true);
  });
});
