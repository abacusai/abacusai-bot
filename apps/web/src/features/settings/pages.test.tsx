import { contract } from "@abacus-ai/contract/contract";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import type { UpdateStatus } from "@abacus-ai/contract/update";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { updateStatusQuery } from "#renderer/features/settings/updates";
import { ABACUS_BUY_CREDITS_URL } from "#renderer/lib/abacus-links";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
const os = implement(contract);
/** `update.events` as main serves it: the current status first, then held open. */
const servedStatus = (...statuses: UpdateStatus[]) =>
  os.update.events.handler(async function* ({ signal }) {
    for (const status of statuses) yield status;
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true })
    );
  });
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
it.each(["basic", "pro"])(
  "account top-up opens the correct %s purchase destination",
  async (tier) => {
    const upgradeUrl = vi.fn(() => "https://example.com/account-offer");
    const openExternal = vi.fn();
    app = await renderApp("/settings/account", {
      procedures: {
        account: {
          abacus: os.account.abacus.handler(
            () =>
              ({
                name: "Alex",
                email: "topup@example.com",
                subscription_tier: tier,
                org_user_count: 1,
              }) as never
          ),
          upgradeUrl: os.account.upgradeUrl.handler(upgradeUrl),
        },
        system: { openExternal: os.system.openExternal.handler(openExternal) },
      },
    });
    await screen.findByText("topup@example.com");
    fireEvent.click(
      within(
        document.querySelector<HTMLElement>('[data-setting-id="credits"]')!
      ).getByRole("button", { name: enUS.phase5.topUp })
    );
    await waitFor(() => expect(openExternal).toHaveBeenCalled());
    expect(openExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          url:
            tier === "basic"
              ? "https://example.com/account-offer"
              : ABACUS_BUY_CREDITS_URL,
        },
      })
    );
    expect(upgradeUrl).toHaveBeenCalledTimes(tier === "basic" ? 1 : 0);
  }
);
it.each([
  ["free", 1, "Upgrade"],
  ["basic", 1, "Manage plan"],
  ["go", 1, "Manage plan"],
  ["pro", 1, "Manage plan"],
  ["max", 1, "Manage plan"],
  ["pro", 4, null],
  ["enterprise", 1, null],
  ["unknown", 1, null],
])(
  "account plan action follows billing policy for %s with %s members",
  async (tier, members, label) => {
    app = await renderApp("/settings/account", {
      procedures: {
        settings: {
          get: os.settings.get.handler(
            () => ({ apiKeys: { ABACUS_API_KEY: "test-key" } }) as never
          ),
        },
        account: {
          abacus: os.account.abacus.handler(
            () =>
              ({
                name: "Billing account",
                email: "billing@example.com",
                subscription_tier: tier,
                plan: tier,
                org_user_count: members,
              }) as never
          ),
        },
      },
    });
    await screen.findByText("billing@example.com");
    const plan = within(
      document.querySelector<HTMLElement>('[data-setting-id="plan"]')!
    );
    if (label) expect(plan.getByRole("button", { name: label })).not.toBeNull();
    else expect(plan.queryByRole("button")).toBeNull();
    const credits = within(
      document.querySelector<HTMLElement>('[data-setting-id="credits"]')!
    );
    if (label === "Manage plan")
      expect(
        credits.getByRole("button", { name: enUS.phase5.topUp })
      ).not.toBeNull();
    else expect(credits.queryByRole("button")).toBeNull();
  }
);
it("R5-T27 rejected install exposes Try again while downloaded and releases the pressed state", async () => {
  const install = vi.fn(async () => {
    throw new Error("quitAndInstall rejected");
  });
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        events: servedStatus({ ...idle, downloaded: true }),
        install: os.update.install.handler(install),
      },
    },
  });
  await screen.findByRole("heading", { name: "About" });
  const row = within(
    document.querySelector<HTMLElement>('[data-setting-id="updates"]')!
  );
  fireEvent.click(
    await row.findByRole("button", { name: enUS.phase5.relaunch })
  );
  const retry = await row.findByRole("button", { name: "Try again" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  expect(screen.getByText("Couldn't install the update")).not.toBeNull();
  fireEvent.click(retry);
  await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
});
it("R5-T27 a critical stalled update has a reachable banner and no blocking dialog", async () => {
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        events: servedStatus({
          ...idle,
          downloaded: true,
          criticalUpdate: true,
          installing: true,
          installStalled: true,
        }),
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
it("R5-T27 critical countdown installs exactly at five minutes", async () => {
  const { act } = await import("@testing-library/react");
  const install = vi.fn(async () => undefined);
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        events: servedStatus(idle),
        install: os.update.install.handler(install),
      },
    },
  });
  const { queryClient, transport } = app!.router.options.context!;
  const key = updateStatusQuery(transport).queryKey;
  // Let the first status arrive before replacing it with a critical update.
  await waitFor(() => expect(queryClient.getQueryData(key)).toEqual(idle));
  vi.useFakeTimers();
  try {
    await act(async () => {
      queryClient.setQueryData(key, {
        ...idle,
        downloaded: true,
        criticalUpdate: true,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("alertdialog")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299000);
    });
    expect(install).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(install).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {},
  { OPENAI_API_KEY: "stored-other-key" },
  { ABACUS_API_KEY: "stored-abacus-key" },
])("sign-out requires a stored Abacus key: %j", async (apiKeys) => {
  app = await renderApp("/settings/account", {
    procedures: {
      settings: { get: os.settings.get.handler(() => ({ apiKeys }) as never) },
      referrals: {
        summary: os.referrals.summary.handler(
          () => ({ inviteLink: "https://example.com/invite" }) as never
        ),
      },
      account: {
        abacus: os.account.abacus.handler(
          () => ({ name: "Ada", email: "ada@example.com" }) as never
        ),
      },
    },
  });
  if ("ABACUS_API_KEY" in apiKeys) {
    await screen.findByText("ada@example.com");
    expect(
      await screen.findByRole("button", { name: enUS.phase5.signOut })
    ).not.toBeNull();
  } else {
    await screen.findByRole("button", { name: "Sign up for free" });
    expect(
      screen.queryByRole("button", { name: enUS.phase5.signOut })
    ).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  }
});
it("a later exhaustion mark forces fresh counters and cannot be cleared by the previous response", async () => {
  const { act } = await import("@testing-library/react");
  const fresh = {
    subscription_tier: "free",
    credits_used: 1,
    credits_granted: 10,
  } as AbacusAccountInfo;
  let release!: (value: AbacusAccountInfo) => void;
  const fetch = vi.fn(async (_context: unknown): Promise<AbacusAccountInfo> =>
    fetch.mock.calls.length === 1
      ? fresh
      : new Promise<AbacusAccountInfo>((resolve) => {
          release = resolve;
        })
  );
  app = await renderApp("/settings/models", {
    procedures: { account: { abacus: os.account.abacus.handler(fetch) } },
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await act(async () => {});
  const mark = Date.now();
  await act(async () => {
    await app!.appDb.updatePrefs({ creditsExhaustedAt: mark });
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[1]![0]).toMatchObject({ input: { refresh: true } });
  expect(app.collections.prefs.get("app")?.creditsExhaustedAt).toBe(mark);
  await act(async () => release(fresh));
  await waitFor(() =>
    expect(app!.collections.prefs.get("app")?.creditsExhaustedAt).toBeNull()
  );
});
it("an install retry event carrying historical failure keeps the critical dialog installing", async () => {
  let release!: () => void;
  const retried = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failed = {
    ...idle,
    downloaded: true,
    criticalUpdate: true,
    error: "old install failure",
    failedPhase: "install" as const,
  };
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        install: os.update.install.handler(() => {
          release();
        }),
        events: os.update.events.handler(async function* ({ signal }) {
          yield failed;
          await retried;
          yield { ...failed, installing: true };
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }),
      },
    },
  });
  const { within } = await import("@testing-library/react");
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "Restarting…" })
        .hasAttribute("disabled")
    ).toBe(true)
  );
  expect(within(dialog).queryByText("old install failure")).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Try again" })
  ).toBeNull();
});

it("the quit watchdog event replaces the critical dialog with a stalled banner", async () => {
  let release!: () => void;
  const watchdog = new Promise<void>((resolve) => {
    release = resolve;
  });
  const installing = {
    ...idle,
    downloaded: true,
    criticalUpdate: true,
    installing: true,
  };
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        events: os.update.events.handler(async function* ({ signal }) {
          yield installing;
          await watchdog;
          yield { ...installing, installStalled: true };
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }),
      },
    },
  });
  await screen.findByRole("alertdialog");
  release();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    await screen.findAllByText(enUS.phase5.updates.stalled)
  ).not.toHaveLength(0);
});

it("keeps Account usable when the referral service is unavailable", async () => {
  app = await renderApp("/settings/account", {
    procedures: {
      referrals: {
        summary: os.referrals.summary.handler(() => {
          throw new Error("Unavailable");
        }),
      },
      account: {
        abacus: os.account.abacus.handler(
          () => ({ name: "Ada", email: "ada@example.com" }) as never
        ),
      },
    },
  });
  await screen.findByText("ada@example.com");
  const row = within(
    document.querySelector<HTMLElement>('[data-setting-id="inviteLink"]')!
  );
  expect(
    row.getByRole("button", { name: enUS.phase5.copy }).hasAttribute("disabled")
  ).toBe(true);
  expect(screen.queryByText(enUS.errors.genericTitle)).toBeNull();
});

it("opens model setup when the optional local runtime is unavailable", async () => {
  app = await renderApp("/onboarding/models", {
    signedIn: true,
    procedures: {
      localModels: {
        state: os.localModels.state.handler(() => {
          throw new Error("The local model runtime is not up");
        }),
      },
    },
  });
  expect(
    await screen.findByRole("heading", {
      name: `${enUS.onboarding.setupTitleLead} ${enUS.onboarding.setupTitleAccent}`,
    })
  ).not.toBeNull();
  expect(
    screen.getByRole("button", { name: enUS.onboarding.setupDoneCta })
  ).not.toBeNull();
  expect(screen.queryByText(enUS.errors.genericTitle)).toBeNull();
});
