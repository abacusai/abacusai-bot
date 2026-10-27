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

import { IS_BROWSER } from "#renderer/lib/platform";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
const os = implement(contract);
const account = (tier: string): AbacusAccountInfo => ({
  user_id: "test",
  organization_id: "test-org",
  name: "Test",
  email: null,
  picture: null,
  organization: null,
  org_user_count: 1,
  plan: tier,
  subscription_tier: tier,
  credits_granted: 100,
  credits_used: 0,
});
const options = (tier: string) => ({
  procedures: {
    account: { abacus: os.account.abacus.handler(() => account(tier)) },
  },
});
it.runIf(IS_BROWSER)(
  "opens one upgrade popover instead of the routine form for free users",
  async () => {
    const app = await renderApp("/routines", options("free"));
    try {
      const nav = await screen.findByRole("navigation", { name: "Routines" });
      const create = await waitFor(() => {
        const button = within(nav).getByRole("button", { name: "New routine" });
        expect(button.getAttribute("aria-haspopup")).toBe("dialog");
        return button;
      });
      fireEvent.click(create);
      const popover = await screen.findByRole("dialog", {
        name: "Unlock routines",
      });
      await waitFor(() =>
        expect(
          within(popover).getAllByRole("button", { name: "Upgrade" })
        ).toHaveLength(1)
      );
      expect(
        within(popover).getByRole("button", { name: "Download desktop" })
      ).toBeTruthy();
      // The sidebar's upgrade card stays alongside the popover.
      expect(
        document.querySelector('[data-slot="upgrade-promo"]')
      ).not.toBeNull();
      expect(screen.queryByRole("textbox", { name: "Instruction" })).toBeNull();
      expect(app.router.state.location.pathname).toBe("/routines");
      expect(app.db.routines.rows.size).toBe(2);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
it.each([
  ...(IS_BROWSER ? [] : ["free"]),
  "basic",
  "go",
  "pro",
  "max",
  "enterprise",
])(
  "keeps routine creation available for %s",
  async (tier) => {
    const app = await renderApp("/routines", options(tier));
    try {
      const nav = await screen.findByRole("navigation", { name: "Routines" });
      const create = await waitFor(() => {
        const button = within(nav).getByRole("button", { name: "New routine" });
        expect(button.hasAttribute("disabled")).toBe(false);
        expect(button.getAttribute("aria-disabled")).not.toBe("true");
        return button;
      });
      fireEvent.click(create);
      expect(
        await screen.findByRole(
          "textbox",
          { name: "Instruction" },
          { timeout: 5000 }
        )
      ).toBeTruthy();
      expect(screen.queryByText("Unlock routines")).toBeNull();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  },
  15000
);
it.runIf(IS_BROWSER)(
  "blocks the direct free create route before showing the form",
  async () => {
    const app = await renderApp("/routines/new", options("free"));
    try {
      expect(
        await screen.findByRole("dialog", { name: "Unlock routines" })
      ).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: "Instruction" })).toBeNull();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
it.runIf(!IS_BROWSER)(
  "once the plan turns paid, sends routines to Abacus AI Agent on the web, once",
  async () => {
    let tier = "free";
    const open = vi.fn();
    const app = await renderApp("/routines", {
      procedures: {
        account: { abacus: os.account.abacus.handler(() => account(tier)) },
        system: {
          openExternal: os.system.openExternal.handler(({ input }) =>
            open(input)
          ),
        },
      },
    });
    const dismissals = () => app.collections.prefs.get("app")?.dismissals;
    try {
      // Read as free first: that read is what makes a later paid one an upgrade.
      await waitFor(() => expect(dismissals()?.freePlanSeenAt).not.toBeNull());
      expect(screen.queryByRole("dialog")).toBeNull();
      tier = "basic";
      await act(async () => {
        await app.router.options.context.queryClient.invalidateQueries({
          queryKey: app.transport.orpc.account.abacus.queryKey(),
        });
      });
      const dialog = await screen.findByRole("dialog", {
        name: "You're on basic",
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Set up 24/7 routines" })
      );
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith({
          url: "https://apps.abacus.ai/chatllm",
        })
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(dismissals()?.upgradeRoutinesSeenAt).not.toBeNull();
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
    const app = await renderApp("/routines", options("basic"));
    try {
      await screen.findByRole("navigation", { name: "Routines" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        app.collections.prefs.get("app")?.dismissals.freePlanSeenAt
      ).toBeNull();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
it.runIf(!IS_BROWSER)(
  "the free Run around the clock card has no close button and shows despite an earlier dismissal",
  async () => {
    const seed = defaultSeed();
    seed.prefs!.dismissals.routinesAlwaysOnCardAt = 1;
    const app = await renderApp("/routines", { seed, ...options("free") });
    try {
      const card = await screen.findByRole("region", {
        name: "Run around the clock",
      });
      expect(
        within(card).getByRole("button", { name: "Upgrade" })
      ).toBeTruthy();
      expect(
        within(card).queryByRole("button", { name: "Dismiss" })
      ).toBeNull();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
it.runIf(!IS_BROWSER)(
  "the paid Run around the clock card can still be dismissed, and stays dismissed",
  async () => {
    const app = await renderApp("/routines", options("pro"));
    try {
      const card = await screen.findByRole("region", {
        name: "Run around the clock",
      });
      fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: "Run around the clock" })
        ).toBeNull()
      );
      expect(
        app.collections.prefs.get("app")?.dismissals.routinesAlwaysOnCardAt
      ).not.toBeNull();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
