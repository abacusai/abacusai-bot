import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { defaultSeed, renderApp } from "#next/test-support/app-harness";
import { contract } from "#shared/contract";
import type { AbacusAccountInfo } from "#shared/contracts";
import type { UpdateStatus } from "#shared/update";
const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
const idle: UpdateStatus = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
};
it("R5-T27 rejected install exposes Try again while downloaded and releases the pressed state", async () => {
  const install = vi.fn(async () => {
    throw new Error("quitAndInstall rejected");
  });
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        status: os.update.status.handler(() => ({ ...idle, downloaded: true })),
        install: os.update.install.handler(install),
      },
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: enUS.phase5.relaunch })
  );
  const retry = await screen.findByRole("button", { name: "Try again" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  expect(screen.getByText("Couldn't install the update")).not.toBeNull();
  fireEvent.click(retry);
  await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
});
it("R5-T27 a critical stalled update has a reachable banner and no blocking dialog", async () => {
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        status: os.update.status.handler(() => ({
          ...idle,
          downloaded: true,
          criticalUpdate: true,
          installStalled: true,
        })),
      },
    },
  });
  expect(
    await screen.findAllByText(enUS.phase5.updates.stalled)
  ).not.toHaveLength(0);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
it.each(["free", "basic", "pro", "unknown"])(
  "R5-T23 credits eligibility for a fresh exhausted %s account",
  async (tier) => {
    const seed = defaultSeed();
    seed.prefs!.creditsExhaustedAt = Date.now();
    const account = {
      subscription_tier: tier,
      credits_used: 10,
      credits_granted: 10,
    } as AbacusAccountInfo;
    app = await renderApp("/settings/models", {
      seed,
      procedures: {
        account: { abacus: os.account.abacus.handler(() => account) },
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Models" })).not.toBeNull()
    );
    if (tier === "free")
      expect(
        await screen.findByText(enUS.phase5.creditsExhausted)
      ).not.toBeNull();
    else
      await waitFor(() =>
        expect(screen.queryByText(enUS.phase5.creditsExhausted)).toBeNull()
      );
    if (tier === "pro")
      await waitFor(() =>
        expect(app!.collections.prefs.get("app")?.creditsExhaustedAt).toBeNull()
      );
  }
);
