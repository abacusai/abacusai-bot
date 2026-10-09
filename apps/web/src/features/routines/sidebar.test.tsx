import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

it("keeps routine creation in the visible header and opens the form for paid users", async () => {
  const os = implement(contract);
  const app = await renderApp("/routines", {
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => ({
          user_id: "test",
          organization_id: "test-org",
          name: "Test",
          email: null,
          picture: null,
          organization: null,
          org_user_count: 1,
          plan: "basic",
          subscription_tier: "basic",
          credits_granted: 100,
          credits_used: 0,
        })),
      },
    },
  });
  try {
    const nav = await screen.findByRole("navigation", { name: "Routines" });
    const header = within(nav).getByRole("heading", {
      name: "Routines",
    }).parentElement!;
    const create = within(header).getByRole("button", { name: "New routine" });
    expect(
      within(nav).getAllByRole("button", { name: "New routine" })
    ).toHaveLength(1);
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/routines/new")
    );
    expect(
      await screen.findByRole("textbox", { name: "Instruction" })
    ).toBeTruthy();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
