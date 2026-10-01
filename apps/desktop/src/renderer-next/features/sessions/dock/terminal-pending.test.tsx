import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { renderApp } from "#next/test-support/app-harness";
import { contract } from "#shared/contract";
import { sessionConversationKey } from "#shared/conversation-scope";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../terminal/terminal-registry", () => ({
  getTerminalView: mocks.get,
  disposeTerminalView: vi.fn(),
}));
// The terminal adapter is deferred; the dock, initializer, router and RPC are real.
vi.mock("ghostty-web", async (original) => ({
  ...(await original<typeof import("ghostty-web")>()),
  UrlRegexProvider: class {
    dispose() {}
  },
  OSC8LinkProvider: class {
    dispose() {}
  },
}));
import { openTab, panelTabsStore } from "./panel-tabs-store";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it.each([true, false])(
  "preserves a newly opened terminal through pending initialization and start, success=%s",
  async (success) => {
    const key = sessionConversationKey("default", "flights");
    panelTabsStore.setState((s) => ({ ...s, [key]: { tabs: [], last: null } }));
    openTab(key, { ref: "files", title: "Files" });
    openTab(key, { ref: "terminal:restored", title: "Restored" });
    const viewReady = deferred<typeof termView>();
    const startReady = deferred<void>();
    const snapshots = Array.from({ length: 3 }, () => deferred<void>());
    mocks.get.mockReturnValue(viewReady.promise);
    const termView = {
      element: document.createElement("div"),
      fit: { proposeDimensions: () => null },
      generation: null,
      offset: undefined,
      received: 0,
      term: {
        cols: 80,
        rows: 24,
        resize: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        attachCustomKeyEventHandler: vi.fn(),
        attachCustomWheelEventHandler: vi.fn(),
        registerLinkProvider: vi.fn(),
        focus: vi.fn(),
      },
    };
    const os = implement(contract);
    const start = vi.fn(async ({ input }) => {
      await startReady.promise;
      return success
        ? {
            success: true,
            state: { terminalId: input.terminalId, generation: 1 },
          }
        : { success: false, error: "start failed" };
    });
    const streamsDone = deferred<void>();
    let eventStreams = 0;
    const output = vi.fn(async function* () {
      await streamsDone.promise;
      yield* [];
    });
    const harness = await renderApp("/sessions/flights?tab=files", {
      terminalEvents: async function* () {
        if (eventStreams++ > 0) {
          await streamsDone.promise;
          return;
        }
        for (const snapshot of snapshots) {
          await snapshot.promise;
          yield { type: "snapshot", states: [] };
        }
        await streamsDone.promise;
      },
      procedures: {
        terminal: {
          start: os.terminal.start.handler(start as never),
          output: os.terminal.output.handler(output),
        },
      },
    });
    let tabUpdates = 0;
    const subscription = panelTabsStore.subscribe(() => {
      tabUpdates++;
    });
    try {
      fireEvent.click(await screen.findByRole("button", { name: "Add tab" }));
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Terminal" })
      );
      await waitFor(() =>
        expect(panelTabsStore.state[key]!.tabs).toHaveLength(3)
      );
      const ref = panelTabsStore.state[key]!.tabs.find(
        (tab) =>
          tab.ref.startsWith("terminal:") && tab.ref !== "terminal:restored"
      )!.ref;
      await waitFor(() =>
        expect(harness.router.state.location.search.tab).toBe(ref)
      );
      await act(async () => {
        snapshots[0]!.resolve();
      });
      await waitFor(() =>
        expect(
          panelTabsStore.state[key]!.tabs.some(
            (tab) => tab.ref === "terminal:restored"
          )
        ).toBe(false)
      );
      expect(
        panelTabsStore.state[key]!.tabs.some((tab) => tab.ref === ref)
      ).toBe(true);
      expect(start).not.toHaveBeenCalled();
      await act(async () => {
        viewReady.resolve(termView);
      });
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
      const beforeSnapshot = tabUpdates;
      await act(async () => {
        snapshots[1]!.resolve();
      });
      await waitFor(() => expect(tabUpdates).toBeGreaterThan(beforeSnapshot));
      expect(
        panelTabsStore.state[key]!.tabs.some((tab) => tab.ref === ref)
      ).toBe(true);
      await act(async () => {
        startReady.resolve();
      });
      if (success) await waitFor(() => expect(output).toHaveBeenCalledOnce());
      else expect(await screen.findByText(/start failed/)).toBeTruthy();
      expect(harness.router.state.location.search.tab).toBe(ref);
      expect(termView.element.isConnected).toBe(success);
      await act(async () => {
        snapshots[2]!.resolve();
      });
      await waitFor(() =>
        expect(
          panelTabsStore.state[key]!.tabs.some((tab) => tab.ref === ref)
        ).toBe(false)
      );
    } finally {
      subscription.unsubscribe();
      harness.view.unmount();
      viewReady.resolve(termView);
      startReady.resolve();
      for (const snapshot of snapshots) snapshot.resolve();
      streamsDone.resolve();
      await harness.cleanup();
    }
  }
);
