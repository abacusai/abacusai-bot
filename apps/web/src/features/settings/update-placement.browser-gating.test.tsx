import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

it("keeps desktop update actions and RPC out of the browser shell", async () => {
  const os = implement(contract);
  const status = vi.fn(() => {
    throw new Error("Desktop updater requested in browser");
  });
  const app = await renderApp("/bots/new", {
    procedures: { update: { status: os.update.status.handler(status) } },
  });
  try {
    await screen.findByRole("textbox", { name: "Name" });
    expect(status).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        '[data-slot="rail-update"], [data-slot="page-update"]'
      )
    ).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
