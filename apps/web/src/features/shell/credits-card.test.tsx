import { contract } from "@abacus-ai/contract/contract";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ABACUS_PLAN_URL } from "#renderer/lib/credits";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
const card = () =>
  document.querySelector<HTMLElement>('[data-slot="upgrade-promo"]');
const mount = async (tier = "free", used = 0, id = "dummy-a") => {
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
              user_id: id,
              organization_id: "dummy-org",
              subscription_tier: tier,
              credits_granted: 100,
              credits_used: used,
            }) as AbacusAccountInfo
        ),
      },
      system: { openExternal: os.system.openExternal.handler(openExternal) },
    },
  });
  return openExternal;
};
it("floats above content with one upgrade action and no sidebar card", async () => {
  const external = await mount();
  await waitFor(() => expect(card()).not.toBeNull());
  expect(
    document.querySelector('[data-slot="sidebar-credits-card"]')
  ).toBeNull();
  expect(card()!.textContent).toContain("100 credits remaining");
  fireEvent.click(within(card()!).getByRole("button", { name: "Upgrade" }));
  await waitFor(() =>
    expect(external).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: { url: ABACUS_PLAN_URL } })
    )
  );
});
it("keeps dismissal across remount and permits another account's promo", async () => {
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(card()).toBeNull());
  app!.view.unmount();
  await app!.cleanup();
  await mount();
  expect(card()).toBeNull();
  app!.view.unmount();
  await app!.cleanup();
  await mount("free", 0, "dummy-b");
  await waitFor(() => expect(card()).not.toBeNull());
});
it("reappears on exhaustion and can dismiss that situation too", async () => {
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(card()).toBeNull());
  app!.view.unmount();
  await app!.cleanup();
  await mount("free", 100);
  await waitFor(() =>
    expect(card()?.textContent).toContain("0 credits remaining")
  );
  fireEvent.click(within(card()!).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(card()).toBeNull());
});
it("does not promote paid or basic accounts", async () => {
  await mount("pro", 100);
  expect(card()).toBeNull();
  app!.view.unmount();
  await app!.cleanup();
  await mount("basic");
  expect(card()).toBeNull();
});
