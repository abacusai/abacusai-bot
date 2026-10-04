import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";

import { dockLeaves } from "./dock-store";
import { openTab, panelTabsStore, updateTabs } from "./panel-tabs-store";
it("rendered dock follows navigation after the local view toggle and saves URL focus", async () => {
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
  });
  const key = sessionConversationKey("default", "spreadsheet");
  openTab(key, { ref: "files", title: "Files" });
  openTab(key, { ref: "changes", title: "Changes" });
  updateTabs(key, (s) => ({
    ...s,
    tree: {
      kind: "leaf",
      id: "root",
      tabs: ["files", "changes"],
      active: "files",
    },
  }));
  const harness = await renderApp("/sessions/spreadsheet?tab=files&view=split");
  const dock = () => document.querySelector('[data-slot="session-dock"]')!;
  try {
    await waitFor(() =>
      expect(dock()?.getAttribute("data-view")).toBe("split")
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle full view" }));
    await waitFor(() => expect(dock().getAttribute("data-view")).toBe("full"));
    await act(async () => {
      await harness.router.navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: "spreadsheet" },
        search: { tab: "changes", view: "split" },
      });
    });
    await waitFor(() => expect(dock().getAttribute("data-view")).toBe("split"));
    expect(panelTabsStore.state[key]!.last).toBe("changes");
    expect(dockLeaves(panelTabsStore.state[key]!.tree!)[0]!.active).toBe(
      "changes"
    );
  } finally {
    harness.view.unmount();
    await harness.cleanup();
    Object.defineProperty(window, "innerWidth", {
      value: width,
      configurable: true,
    });
  }
});
it("normalizes an absent terminal URL after the initial terminal snapshot", async () => {
  const key = sessionConversationKey("default", "flights");
  openTab(key, { ref: "files", title: "Files" });
  const harness = await renderApp("/sessions/flights?tab=terminal:missing", {
    terminalEvents: async function* () {
      yield { type: "snapshot", states: [] };
    },
  });
  try {
    await waitFor(() =>
      expect(harness.router.state.location.search).toMatchObject({
        tab: "files",
      })
    );
  } finally {
    harness.view.unmount();
    await harness.cleanup();
  }
});
