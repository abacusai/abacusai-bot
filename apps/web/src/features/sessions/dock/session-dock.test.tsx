import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { openTab, panelTabsStore } from "./panel-tabs-store";
it("rendered dock follows navigation after the local view toggle and saves URL focus", async () => {
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
  });
  const key = sessionConversationKey("default", "spreadsheet");
  openTab(key, { ref: "files", title: "Files" });
  openTab(key, { ref: "changes", title: "Changes" });
  const harness = await renderApp("/sessions/spreadsheet?tab=files&view=split");
  const dock = () => document.querySelector('[data-slot="session-dock"]')!;
  try {
    await waitFor(() =>
      expect(dock()?.getAttribute("data-view")).toBe("split")
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle full view" }));
    await waitFor(() => expect(dock().getAttribute("data-view")).toBe("full"));
    fireEvent.click(
      within(
        document.querySelector<HTMLElement>('[data-slot="topbar"]')!
      ).getByRole("tab", { name: "Chat" })
    );
    await waitFor(() =>
      expect(harness.router.state.location.search.tab).toBe("chat")
    );
    expect(panelTabsStore.state[key]!.last).toBe("files");
    expect(
      screen.getByTestId("panel-toggle").getAttribute("aria-pressed")
    ).toBe("true");
    fireEvent.click(screen.getByTestId("panel-toggle"));
    await waitFor(() =>
      expect(harness.router.state.location.search.tab).toBeUndefined()
    );
    fireEvent.click(screen.getByTestId("panel-toggle"));
    await waitFor(() =>
      expect(harness.router.state.location.search.tab).toBe("files")
    );
    await act(async () => {
      await harness.router.navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: "spreadsheet" },
        search: { tab: "changes", view: "split" },
      });
    });
    await waitFor(() => expect(dock().getAttribute("data-view")).toBe("split"));
    expect(panelTabsStore.state[key]!.last).toBe("changes");
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

it("restores the selected workspace file when returning to a session without URL state", async () => {
  const key = sessionConversationKey("default", "spreadsheet");
  const harness = await renderApp(
    "/sessions/spreadsheet?tab=files&file=README.md"
  );
  try {
    await waitFor(() =>
      expect(
        panelTabsStore.state[key]?.tabs.find((tab) => tab.ref === "files")?.path
      ).toBe("README.md")
    );
    await act(async () => {
      await harness.router.navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: "flights" },
        search: { tab: "files" },
      });
      await harness.router.navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: "spreadsheet" },
        search: {},
      });
    });
    await waitFor(() => {
      const pane = document.querySelector('[data-dock-pane="files"]');
      expect(pane?.textContent).toContain("README.md");
    });
  } finally {
    harness.view.unmount();
    await harness.cleanup();
  }
});
