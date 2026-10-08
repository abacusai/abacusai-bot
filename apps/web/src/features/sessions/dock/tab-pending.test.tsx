/**
 * A tab whose chunk has not arrived suspends inside its own pane: the dock
 * and its chat and tools panes are laid out at once, with a pending state
 * where the tab goes (the 1100 split screenshot measures them right away).
 */
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { openTab } from "./panel-tabs-store";

// The files tab's chunk never arrives.
vi.mock("../files/files-tab", () => new Promise(() => undefined));

it("mounts the dock's panes with a pending files tab while its chunk loads", async () => {
  const key = sessionConversationKey("default", "spreadsheet");
  openTab(key, { ref: "files", title: "Files" });
  const harness = await renderApp("/sessions/spreadsheet?tab=files&view=split");
  try {
    const pane = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-slot="session-dock"][data-view="split"] [data-dock-pane="files"]'
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(
      document.querySelector('[data-workspace-pane="chat"]')
    ).not.toBeNull();
    expect(pane.closest('[data-workspace-pane="tools"]')).not.toBeNull();
    expect(within(pane).getByRole("status", { name: "Loading" })).toBeDefined();
    expect(screen.queryByText("Loading")).toBeNull();
  } finally {
    harness.view.unmount();
    await harness.cleanup();
  }
});
