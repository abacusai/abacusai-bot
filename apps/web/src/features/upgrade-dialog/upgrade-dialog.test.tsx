import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DbProvider } from "#renderer/data/db";
import { checkPlanNow } from "#renderer/lib/upgrade";
import {
  closeUpgradeDialog,
  requestUpgradeDialog,
} from "#renderer/lib/upgrade-dialog";
import { createHarness, defaultSeed } from "#renderer/test-support/app-harness";

import { UpgradeDialogHost } from "./upgrade-dialog";

const FREE = {
  user_id: "u1",
  organization_id: "o1",
  name: null,
  email: null,
  picture: null,
  organization: null,
  org_user_count: null,
  plan: null,
  subscription_tier: "free" as string | null,
  credits_granted: 2000,
  credits_used: 2000,
};

const BILLING: BillingPlan = {
  current: {
    planName: "Free",
    creditsRemaining: 0,
    creditsGranted: 2000,
    freeTierExpiresAt: null,
  },
  plans: [],
  upgrades: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/mo",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features: [],
      url: null,
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

const OPUS: ModelAvailability = {
  id: "abacus/claude-opus-5-5",
  label: "Claude Opus 5.5",
  provider: "abacus",
  tier: "strong",
  configured: false,
  access: "locked",
};

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

it("once the plan is active, the waiting message of a task goes on the plan's top model it now runs", async () => {
  const resume = vi.fn(async (_model?: string) => {});
  let account = FREE;
  let models: ModelAvailability[] = [OPUS];
  const os = implement(contract);
  const harness = await createHarness("/", {
    seed: { ...defaultSeed(), sessions: [] },
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => account),
        billingPlan: os.account.billingPlan.handler(() => BILLING),
      },
      models: { list: os.models.list.handler(() => models) },
      system: { openExternal: os.system.openExternal.handler(vi.fn()) },
    },
  });
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={harness.router.options.context.queryClient}>
        <RouterContextProvider router={harness.router}>
          <DbProvider value={harness.appDb}>
            <UpgradeDialogHost />
          </DbProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  });
  cleanup = async () => {
    closeUpgradeDialog();
    rendered.unmount();
    await harness.cleanup();
  };
  act(() =>
    requestUpgradeDialog(
      {
        kind: "credits",
        key: "k1",
        threadId: "t1",
        pendingText: "still cut off",
        task: "Invoice app",
        resume,
      },
      true
    )
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Upgrade and finish it" })
  );
  // The plan lands: the account reads Basic and the catalog runs Opus.
  account = {
    ...FREE,
    subscription_tier: "basic",
    credits_granted: 20000,
    credits_used: 0,
  };
  models = [{ ...OPUS, configured: true, access: "runnable" }];
  act(() => checkPlanNow());
  await waitFor(() =>
    expect(resume).toHaveBeenCalledWith("abacus/claude-opus-5-5")
  );
});

it("the wall asked again on return is counted with “your work is waiting”: shown, and Upgrade tapped", async () => {
  const os = implement(contract);
  const harness = await createHarness("/", {
    seed: { ...defaultSeed(), sessions: [] },
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => FREE),
        billingPlan: os.account.billingPlan.handler(() => BILLING),
      },
      system: { openExternal: os.system.openExternal.handler(vi.fn()) },
    },
  });
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={harness.router.options.context.queryClient}>
        <RouterContextProvider router={harness.router}>
          <DbProvider value={harness.appDb}>
            <UpgradeDialogHost />
          </DbProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  });
  cleanup = async () => {
    closeUpgradeDialog();
    rendered.unmount();
    await harness.cleanup();
  };
  const steps = () =>
    harness.calls
      .filter(([name]) => name === "system.funnelStep")
      .map(([, input]) => input);
  act(() =>
    requestUpgradeDialog(
      {
        kind: "credits",
        key: "wall-reopen:1",
        threadId: "t1",
        pendingText: "still cut off",
        reopen: true,
        resume: async () => {},
      },
      true
    )
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Upgrade to Basic" })
  );
  await waitFor(() =>
    expect(steps()).toEqual([
      { step: "work_waiting_shown", detail: "wall" },
      { step: "work_waiting_clicked", detail: "wall" },
    ])
  );
});

it("a wall from before an upgrade offers a payer with credits nothing: no dialog, no next plan", async () => {
  const os = implement(contract);
  const harness = await createHarness("/", {
    seed: { ...defaultSeed(), sessions: [] },
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => ({
          ...FREE,
          subscription_tier: "basic",
          credits_granted: 20_000,
          credits_used: 0,
        })),
        billingPlan: os.account.billingPlan.handler(() => ({
          ...BILLING,
          current: { ...BILLING.current, planName: "Basic" },
          upgrades: [
            {
              ...BILLING.upgrades[0]!,
              plan: "pro",
              planName: "Pro",
              priceText: "$20/mo",
            },
          ],
          topUpUrl: "https://example.test/top-up",
        })),
      },
      system: { openExternal: os.system.openExternal.handler(vi.fn()) },
    },
  });
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={harness.router.options.context.queryClient}>
        <RouterContextProvider router={harness.router}>
          <DbProvider value={harness.appDb}>
            <UpgradeDialogHost />
          </DbProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  });
  cleanup = async () => {
    closeUpgradeDialog();
    rendered.unmount();
    await harness.cleanup();
  };
  act(() =>
    requestUpgradeDialog(
      {
        kind: "credits",
        key: "wall-reopen:2",
        threadId: "t1",
        pendingText: "still cut off",
        reopen: true,
        resume: async () => {},
      },
      true
    )
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    harness.calls.filter(([name]) => name === "system.funnelStep")
  ).toEqual([]);
});
