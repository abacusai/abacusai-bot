import { contract } from "@abacus-ai/contract/contract";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { IS_BROWSER } from "#renderer/lib/platform";
import { renderApp } from "#renderer/test-support/app-harness";
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
it("opens one upgrade popover instead of the routine form for free users", async () => {
  const app = await renderApp("/routines", options("free"));
  try {
    const nav = await screen.findByRole("navigation", { name: "Routines" });
    const create = await waitFor(() => {
      const button = within(nav).getByRole("button", { name: "New routine" });
      expect(button.getAttribute("aria-haspopup")).toBe("dialog");
      return button;
    });
    fireEvent.click(create);
    expect(await screen.findByText("Unlock routines")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Upgrade" })).toHaveLength(1)
    );
    expect(
      Boolean(screen.queryByRole("button", { name: "Download desktop" }))
    ).toBe(IS_BROWSER);
    expect(screen.queryByRole("textbox", { name: "Instruction" })).toBeNull();
    expect(app.router.state.location.pathname).toBe("/routines");
    expect(app.db.routines.rows.size).toBe(2);
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
it.each(["basic", "go", "pro", "max", "enterprise"])(
  "keeps routine creation available for %s",
  async (tier) => {
    const app = await renderApp("/routines", options(tier));
    try {
      const nav = await screen.findByRole("navigation", { name: "Routines" });
      const create = await waitFor(() => {
        const button = within(nav).getByRole("button", { name: "New routine" });
        expect(button.hasAttribute("disabled")).toBe(false);
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
  }
);
it("blocks the direct free create route before showing the form", async () => {
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
});
