import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

it("keeps routine creation in the visible header and opens the existing create form", async () => {
  const app = await renderApp("/routines");
  try {
    const nav = await screen.findByRole("navigation", { name: "Routines" });
    const header = within(nav).getByRole("heading", {
      name: "Routines",
    }).parentElement!;
    const create = within(header).getByRole("button", { name: "New routine" });
    expect(
      within(nav).getAllByRole("button", { name: "New routine" })
    ).toHaveLength(1);
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
