import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
import { contract } from "@abacus-ai/contract/contract";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { FREE_POOL_PROVIDERS } from "@abacus-ai/contract/free-pool";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
const card = () =>
  document.querySelector<HTMLElement>('[data-slot="sidebar-credits-card"]');
const mount = async (
  tier: string,
  used: number,
  providers: string[] = [],
  runtimeAvailable = false
) => {
  const seed = defaultSeed();
  seed.prefs!.creditsExhaustedAt = null;
  const openExternal = vi.fn(
    async (_options: { input: { url: string } }) => {}
  );
  app = await renderApp("/bots", {
    seed,
    procedures: {
      account: {
        abacus: os.account.abacus.handler(
          () =>
            ({
              subscription_tier: tier,
              credits_granted: 100,
              credits_used: used,
            }) as AbacusAccountInfo
        ),
      },
      models: { list: os.models.list.handler(() => []) },
      settings: {
        keys: {
          listProviders: os.settings.keys.listProviders.handler(
            () => providers
          ),
        },
      },
      localModels: {
        state: os.localModels.state.handler(() => ({
          runtimeAvailable,
          totalMemoryBytes: 0,
          recommendedId: "qwen3.5-4b",
          catalog: [],
          installedIds: [],
          download: null,
          servingId: null,
        })),
      },
      system: { openExternal: os.system.openExternal.handler(openExternal) },
    },
  });
  return openExternal;
};
it("uses account counters without a local mark and keeps the exhaustion explanation open", async () => {
  await mount("free", 100);
  await waitFor(() =>
    expect(card()?.textContent).toContain(enUS.creditsCard.connectBody)
  );
  await waitFor(() =>
    expect(card()?.querySelector('[data-source="gemini"]')).not.toBeNull()
  );
  expect(
    within(card()!).queryByRole("button", { name: enUS.creditsCard.dismiss })
  ).toBeNull();
  fireEvent.click(
    within(card()!).getByRole("button", { name: enUS.creditsCard.inviteCta })
  );
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/settings/account")
  );
  expect(app!.router.state.location.search).toMatchObject({ invite: "link" });
});
it("remembers dismissing the headroom upsell, but still shows later exhaustion", async () => {
  await mount("free", 10);
  await waitFor(() =>
    expect(card()?.textContent).toContain(enUS.creditsCard.upsellTitle)
  );
  fireEvent.click(
    within(card()!).getByRole("button", { name: enUS.creditsCard.dismiss })
  );
  expect(card()).toBeNull();
  app!.view.unmount();
  await app!.cleanup();
  app = undefined;
  await mount("free", 100);
  await waitFor(() =>
    expect(card()?.textContent).toContain(enUS.creditsCard.connectBody)
  );
});
it("prefers a configured provider outside the exhausted pool", async () => {
  await mount("free", 100, ["openai"]);
  await waitFor(() =>
    expect(card()?.textContent).toContain(enUS.creditsCard.switchTitle)
  );
  expect(card()?.textContent).toContain("OpenAI");
  expect(card()?.querySelector("button")).toBeNull();
});
it("opens local setup once all free sources are configured", async () => {
  await mount("free", 100, [...FREE_POOL_PROVIDERS], true);
  await waitFor(() =>
    expect(card()?.textContent).toContain(enUS.creditsCard.localBody)
  );
  fireEvent.click(
    within(card()!).getByRole("button", { name: enUS.localModels.useLocal })
  );
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/settings/models")
  );
  expect(app!.router.state.location.search).toMatchObject({
    provider: "local",
  });
});
it("points at the picker without buttons when the runtime is unavailable and sources are connected", async () => {
  await mount("free", 100, [...FREE_POOL_PROVIDERS]);
  await waitFor(() =>
    expect(card()?.textContent).toContain(enUS.creditsCard.pickBody)
  );
  expect(card()?.querySelector("button")).toBeNull();
});
it("offers a spent paid account its top-up, with no free sources", async () => {
  const open = await mount("pro", 100);
  await waitFor(() =>
    expect(card()?.textContent).toContain(enUS.creditsCard.paidTitle)
  );
  fireEvent.click(
    within(card()!).getByRole("button", { name: enUS.creditsCard.topUpCta })
  );
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(open.mock.calls[0]?.[0].input.url).toContain("buyCredits=true");
  expect(card()?.querySelector("[data-source]")).toBeNull();
});
it.each(["basic", "pro"])(
  "keeps a %s account with headroom free of an upsell",
  async (tier) => {
    await mount(tier, 10);
    await screen.findByRole("heading", { name: "Bots" });
    expect(card()).toBeNull();
  }
);
