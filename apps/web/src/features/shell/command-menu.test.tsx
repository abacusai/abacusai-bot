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
it("lists Files, Changes and PR after the other panels outside a code project, and before them inside one", async () => {
  const order = async (notGit: boolean) => {
    const app = await renderApp("/sessions/compress-installers", { notGit });
    try {
      fireEvent.click(
        await screen.findByRole("button", { name: "Command menu" })
      );
      await screen.findByPlaceholderText(
        "Search areas, pages, bots and sessions"
      );
      const titles = () =>
        screen.getAllByRole("option").map((option) => option.textContent);
      // The signal arrives with the branch query; wait for its answer.
      await waitFor(() => {
        const names = titles();
        const files = names.findIndex((name) => name?.startsWith("Files"));
        const full = names.findIndex((name) =>
          name?.startsWith("Toggle full view")
        );
        expect(files).toBeGreaterThanOrEqual(0);
        expect(full).toBeGreaterThanOrEqual(0);
        expect(notGit ? files > full : files < full).toBe(true);
      });
      return titles();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  };
  const plain = await order(true);
  expect(plain.some((name) => name?.startsWith("Changes"))).toBe(true);
  await order(false);
});
