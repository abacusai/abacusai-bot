import { contract } from "@abacus-ai/contract/contract";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { implement } from "@orpc/server";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { welcomeLandedPlan } from "#renderer/lib/paid-welcome";
import { IS_BROWSER } from "#renderer/lib/platform";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
const account = (
  tier: string,
  credits: { granted: number | null; used: number | null } = {
    granted: 20000,
    used: 1500,
  }
): AbacusAccountInfo => ({
  user_id: "test",
  organization_id: "test-org",
  name: "Test",
  email: null,
  picture: null,
  organization: null,
  org_user_count: 1,
  plan: tier,
  subscription_tier: tier,
  credits_granted: credits.granted,
  credits_used: credits.used,
});

const render = async (read: () => AbacusAccountInfo, seed = defaultSeed()) => {
  const open = vi.fn();
  const steps: string[] = [];
  const app = await renderApp("/routines", {
    seed,
    procedures: {
      account: { abacus: os.account.abacus.handler(read) },
      system: {
        openExternal: os.system.openExternal.handler(({ input }) =>
          open(input)
        ),
        funnelStep: os.system.funnelStep.handler(({ input }) => {
          steps.push(input.step);
        }),
      },
    },
  });
  const dismissals = () => app.collections.prefs.get("app")?.dismissals;
  const refresh = () =>
    act(async () => {
      await app.router.options.context.queryClient.invalidateQueries({
        queryKey: app.transport.orpc.account.abacus.queryKey(),
      });
    });
  return { app, open, steps, dismissals, refresh };
};

it.runIf(!IS_BROWSER)(
  "welcomes a paid read after a free one, once, with its balance, and sends routines to the web",
  async () => {
    let tier = "free";
    const { app, open, steps, dismissals, refresh } = await render(() =>
      account(tier)
    );
    try {
      await waitFor(() => expect(dismissals()?.freePlanSeenAt).not.toBeNull());
      expect(screen.queryByRole("dialog")).toBeNull();
      tier = "basic";
      await refresh();
      const dialog = await screen.findByRole("dialog", {
        name: "You're on basic",
      });
      expect(
        within(dialog).getByText("18,500 credits ready to use")
      ).toBeTruthy();
      expect(
        within(dialog).queryByRole("button", {
          name: /Finish what you were doing/,
        })
      ).toBeNull();
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Set up a 24/7 routine on the web",
        })
      );
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith({
          url: "https://apps.abacus.ai/chatllm",
        })
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(dismissals()?.paidWelcomeTier).toBe("basic");
      expect(steps).toEqual(["paid_welcome_shown", "paid_welcome_routines"]);
      await refresh();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  },
  15000
);

it.runIf(!IS_BROWSER)(
  "never tells an account first read as paid that it just upgraded",
  async () => {
    const { app, dismissals } = await render(() => account("basic"));
    try {
      await screen.findByRole("navigation", { name: "Routines" });
      await waitFor(() => expect(dismissals()?.paidWelcomeTier).toBe("basic"));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(dismissals()?.freePlanSeenAt).toBeNull();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);

it.runIf(!IS_BROWSER)(
  "welcomes a move up from Basic to Pro, and shows no balance it cannot read",
  async () => {
    const seed = defaultSeed();
    seed.prefs!.dismissals.freePlanSeenAt = 1;
    seed.prefs!.dismissals.paidWelcomeTier = "basic";
    const { app, steps } = await render(
      () => account("pro", { granted: null, used: null }),
      seed
    );
    try {
      const dialog = await screen.findByRole("dialog", {
        name: "You're on pro",
      });
      expect(
        dialog.querySelector('[data-slot="paid-welcome-credits"]')
      ).toBeNull();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Back to chat" })
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(steps).toEqual(["paid_welcome_shown", "paid_welcome_closed"]);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);

it.runIf(!IS_BROWSER)(
  "takes the turn a watched payment paused, and sends it only from Finish what you were doing",
  async () => {
    let tier = "free";
    const { app, steps, dismissals } = await render(() => account(tier));
    try {
      await waitFor(() => expect(dismissals()?.freePlanSeenAt).not.toBeNull());
      tier = "basic";
      const resume = vi.fn(async () => undefined);
      act(() =>
        welcomeLandedPlan(account("basic"), account("free"), {
          threadId: "chat-1",
          paused: { text: "Build my bakery website", resume },
        })
      );
      const dialog = await screen.findByRole("dialog", {
        name: "You're on basic",
      });
      expect(resume).not.toHaveBeenCalled();
      const finish = within(dialog).getByRole("button", {
        name: /Finish what you were doing/,
      });
      expect(finish.textContent).toContain("Build my bakery website");
      fireEvent.click(finish);
      await waitFor(() => expect(resume).toHaveBeenCalledOnce());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(steps).toEqual(["paid_welcome_shown", "paid_welcome_resume"]);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  },
  15000
);

it.runIf(!IS_BROWSER)(
  "leads with the deploy steps when the chat's latest result is a site",
  async () => {
    const seed = defaultSeed();
    seed.prefs!.dismissals.freePlanSeenAt = 1;
    seed.prefs!.siteReady = {
      "chat-1": { turnId: "turn-1", siteDir: "/work/bakery", at: 1 },
    };
    const packed = vi.fn();
    const open = vi.fn();
    const steps: string[] = [];
    const app = await renderApp("/routines", {
      seed,
      procedures: {
        account: { abacus: os.account.abacus.handler(() => account("free")) },
        sites: {
          pack: os.sites.pack.handler(({ input }) => {
            packed(input.sessionId);
            return {
              state: "ready" as const,
              path: "/exports/bakery.zip",
              name: "bakery",
              files: 23,
              bytes: 1_240_000,
              leftOut: ["node_modules"],
              heldBack: [],
            };
          }),
          progress: os.sites.progress.handler(() => null),
        },
        system: {
          openExternal: os.system.openExternal.handler(({ input }) =>
            open(input)
          ),
          funnelStep: os.system.funnelStep.handler(({ input }) => {
            steps.push(`${input.step}:${input.detail ?? ""}`);
          }),
        },
      },
    });
    try {
      await screen.findByRole("navigation", { name: "Routines" });
      act(() =>
        welcomeLandedPlan(account("basic"), account("free"), {
          threadId: "chat-1",
          paused: null,
        })
      );
      const dialog = await screen.findByRole("dialog", {
        name: "You're on basic",
      });
      expect(within(dialog).getByText("Deploy your site")).toBeTruthy();
      expect(await within(dialog).findByText("bakery.zip")).toBeTruthy();
      expect(packed).toHaveBeenCalledWith("chat-1");
      expect(
        within(dialog).queryByRole("button", {
          name: "Set up a 24/7 routine on the web",
        })
      ).toBeNull();
      fireEvent.click(
        within(dialog).getByRole("button", { name: /Open Abacus AI Agent/ })
      );
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith({
          url: "https://apps.abacus.ai/chatllm",
        })
      );
      expect(steps).toEqual(
        expect.arrayContaining([
          "site_deploy_shown:welcome",
          "site_deploy_open_agent:welcome",
        ])
      );
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  },
  15000
);
