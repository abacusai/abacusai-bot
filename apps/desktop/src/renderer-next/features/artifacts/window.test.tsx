import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { defaultSeed, renderApp } from "#next/test-support/app-harness";

import { artifactStressRows } from "./gallery";
beforeEach(() => {
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
});
it("rendered grid eviction preserves full-row anchors including the 10px gap", async () => {
  const seed = defaultSeed();
  seed.artifacts = artifactStressRows;
  app = await renderApp("/artifacts", { seed });
  const grid = await screen.findByRole("list");
  const viewport = grid.parentElement!;
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
  const observer = observations.find(
    (entry) => entry.element === grid.parentElement
  );
  expect(observer).toBeDefined();
  await act(async () => observer!.resize(450));
  await waitFor(() =>
    expect(grid.style.gridTemplateColumns).toBe("repeat(2,minmax(0,1fr))")
  );
  await act(async () => observer!.resize(1100));
  await waitFor(() =>
    expect(grid.style.gridTemplateColumns).toBe("repeat(5,minmax(0,1fr))")
  );
});
