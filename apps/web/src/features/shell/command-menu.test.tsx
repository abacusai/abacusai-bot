import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

it("opens the one palette from the sidebar command action, groups results and navigates to Models", async () => {
  const app = await renderApp("/sessions/spreadsheet");
  try {
    const trigger = await screen.findByRole("button", {
      name: "Command menu",
    });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    trigger.focus();
    fireEvent.click(trigger);
    const input = await screen.findByPlaceholderText(
      "Search areas, pages, bots and sessions"
    );
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-slot="command-item"]').length
      ).toBeGreaterThan(10)
    );
    fireEvent.change(input, { target: { value: "Models" } });
    const item = await screen.findByRole("option", { name: "Models" });
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "Models" }).querySelector("mark")
      ).not.toBeNull()
    );
    fireEvent.click(item);
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/settings/models")
    );
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
it("shows the empty state for a non-match and keeps the current route on dismissal", async () => {
  const app = await renderApp("/sessions/spreadsheet");
  try {
    const trigger = await screen.findByRole("button", {
      name: "Command menu",
    });
    trigger.focus();
    fireEvent.click(trigger);
    const input = await screen.findByPlaceholderText(
      "Search areas, pages, bots and sessions"
    );
    fireEvent.change(input, { target: { value: "zzzznoresults" } });
    await screen.findByText("No results");
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(app.router.state.location.pathname).toBe("/sessions/spreadsheet");
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
