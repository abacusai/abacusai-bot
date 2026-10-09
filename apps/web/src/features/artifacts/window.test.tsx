import { contract } from "@abacus-ai/contract/contract";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

import { artifactStressRows } from "./gallery";
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  );
});
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("rendered grid eviction preserves full-row anchors including the 10px gap", async () => {
  const seed = defaultSeed();
  seed.artifacts = artifactStressRows;
  app = await renderApp("/artifacts", { seed });
  const grid = await screen.findByRole("list");
  // The grid sits in the wide content column; the viewport scrolls above it.
  const viewport = grid.parentElement!.parentElement!;
  const columns = Number(
    grid.style.gridTemplateColumns.match(/repeat\((\d+)/)![1]
  );
  fireEvent.scroll(viewport, { target: { scrollTop: 190 * 11 } });
  const first = grid.querySelector<HTMLElement>("[data-artifact-card]")!;
  expect(first.textContent).toContain(
    `Artifact ${String(7 * columns).padStart(4, "0")}`
  );
  expect((grid.previousElementSibling as HTMLElement).style.height).toBe(
    `${190 * 7}px`
  );
});
it("a grid appearing after an empty snapshot observes later viewport resizes", async () => {
  const observations: Array<{ element: Element; resize(width: number): void }> =
    [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        observations.push({
          element,
          resize: (width) =>
            this.callback(
              [
                {
                  target: element,
                  contentRect: { width, height: 600 },
                } as ResizeObserverEntry,
              ],
              this as unknown as ResizeObserver
            ),
        });
      }
      disconnect() {}
      unobserve() {}
    }
  );
  const seed = defaultSeed();
  seed.artifacts = [];
  app = await renderApp("/artifacts", { seed });
  await screen.findByText("Nothing made yet");
  await act(async () => app!.db.artifacts.upsert(artifactStressRows[400]!));
  const grid = await screen.findByRole("list");
  const observers = observations.filter(
    (entry) => entry.element === grid.parentElement!.parentElement
  );
  expect(observers.length).toBeGreaterThan(0);
  await act(async () => {
    for (const observer of observers) observer.resize(450);
  });
  await waitFor(() =>
    expect(grid.style.gridTemplateColumns).toBe("repeat(2,minmax(0,1fr))")
  );
  await act(async () => {
    for (const observer of observers) observer.resize(1100);
  });
  await waitFor(() =>
    expect(grid.style.gridTemplateColumns).toBe("repeat(5,minmax(0,1fr))")
  );
});

it.each(["pdf", "html"])(
  "Artifacts %s uses the real host reader and releases its lease",
  async (extension) => {
    const seed = defaultSeed();
    const artifact = {
      ...artifactStressRows[400]!,
      id: "host-preview",
      workspaceId: "artifact-workspace",
      sessionId: "artifact-session",
      location: `/guest/report.${extension}`,
    };
    seed.artifacts = [artifact];
    const lease = {
      conversationKey: sessionConversationKey(
        artifact.workspaceId,
        artifact.sessionId
      ),
      resourceId: `artifact-preview:${artifact.id}`,
      generation: 1,
    };
    const close = vi.fn();
    const materializeFile = vi.fn(async () => ({
      lease,
      url: `file:///host/report.${extension}`,
      title: "report",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      focused: false,
      crashed: false,
      devToolsOpen: false,
      zoomFactor: 1,
    }));
    app = await renderApp("/artifacts?item=host-preview", {
      seed,
      materializeFile,
      procedures: {
        browser: {
          runtime: {
            close: implement(contract).browser.runtime.close.handler(
              ({ input }) => close(input)
            ),
          },
        },
      },
    });
    await waitFor(() =>
      expect(document.querySelector("webview")?.getAttribute("src")).toBe(
        `file:///host/report.${extension}${extension === "pdf" ? "#view=FitH" : ""}`
      )
    );
    expect(materializeFile).toHaveBeenCalledWith({
      filePath: artifact.location,
      hostRoot: "/guest",
      conversationKey: lease.conversationKey,
      resourceId: lease.resourceId,
    });
    expect(close).toHaveBeenCalledWith(lease);
  }
);
