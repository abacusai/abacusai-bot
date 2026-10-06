/**
 * The chat layout's geometry: the transcript column and the composer column
 * take their clamps from the shell's tokens (`--transcript-max-w`,
 * `--composer-max-w`), the composer a step narrower and both centred.
 */
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SHELL_GEOMETRY } from "#renderer/features/shell/geometry";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

// Read from disk: `?raw` of chat.css is empty in this pipeline (chat-css.test).
const nodeFs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: "node:fs"): unknown };
  }
).process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const chatCss = nodeFs.readFileSync(
  `${(import.meta as ImportMeta & { dirname: string }).dirname}/../chat.css`,
  "utf8"
);

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

describe("chat layout widths", () => {
  it("clamps the transcript and the composer with the shell tokens", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      ...b.text("u0", "user", "hello"),
      ...b.text("a0", "assistant", "hi"),
    ]);
    current = await renderRelay(relay, "bot");
    await screen.findByText("hi");
    const content = document.querySelector(
      '[data-slot="message-scroller-content"]'
    )!;
    expect(content.className).toContain("max-w-(--transcript-max-w)");
    expect(content.className).toContain("mx-auto");
    const dock = document.querySelector('[data-slot="composer-dock"]')!;
    expect(dock.className).toContain("max-w-(--composer-max-w)");
    expect(dock.className).toContain("mx-auto");
    expect(SHELL_GEOMETRY.composerMaxW).toBeLessThan(
      SHELL_GEOMETRY.transcriptMaxW
    );
  });
});

describe("the floating composer dock", () => {
  it("floats over the transcript's end and pads the scroller by its measured height", async () => {
    type Callback = (entries: ResizeObserverEntry[]) => void;
    let callback: Callback | null = null;
    const observed: Element[] = [];
    class FakeResizeObserver {
      constructor(fn: Callback) {
        callback = fn;
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      const relay = new FakeRelay();
      relay.emitAll([
        ...b.sessionReady(),
        ...b.text("u0", "user", "hello"),
        ...b.text("a0", "assistant", "hi"),
      ]);
      current = await renderRelay(relay, "bot");
      await screen.findByText("hi");
      const layout = document.querySelector<HTMLElement>(
        '[data-slot="chat-layout"]'
      )!;
      const dock = document.querySelector<HTMLElement>(
        '[data-slot="composer-dock"]'
      )!;
      // Absolutely positioned at the layout's bottom, over the transcript;
      // only its children take the pointer.
      expect(layout.className).toContain("relative");
      expect(dock.className).toContain("absolute");
      expect(dock.className).toContain("bottom-0");
      expect(dock.className).toContain("pointer-events-none");
      expect(chatCss).toMatch(
        /\[data-slot="composer-dock"\] > \* \{\s*pointer-events: auto;/
      );
      // The composer and its companions live in the dock.
      expect(dock.querySelector('[data-slot="composer"]')).not.toBeNull();
      // The scroller's end padding and the jump button follow the dock's
      // measured height, written as a custom property on the layout.
      expect(observed).toContain(dock);
      act(() => {
        callback!([
          {
            target: dock,
            borderBoxSize: [{ blockSize: 123, inlineSize: 700 }],
          } as unknown as ResizeObserverEntry,
        ]);
      });
      expect(layout.style.getPropertyValue("--composer-dock-h")).toBe("123px");
      const content = document.querySelector(
        '[data-slot="message-scroller-content"]'
      )!;
      expect(content.className).toContain(
        "pb-[calc(var(--composer-dock-h,0px)+var(--composer-dock-gap,16px))]"
      );
      const jump = document.querySelector(
        '[data-slot="message-scroller-button"]'
      )!;
      expect(jump.className).toContain(
        "bottom-[calc(var(--composer-dock-h,0px)+var(--composer-dock-gap,16px))]"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is glass only on native material and opaque under reduced transparency", async () => {
    const relay = new FakeRelay();
    relay.emitAll([...b.sessionReady(), ...b.text("a0", "assistant", "hi")]);
    current = await renderRelay(relay, "bot");
    await screen.findByText("hi");
    const surface = document.querySelector<HTMLElement>(
      '[data-slot="composer-surface"]'
    )!;
    // Opaque by default: the Tailwind surface colour, no blur.
    expect(surface.className).toContain("bg-[var(--chat-surface)]");
    // Translucent only inside the same gate as the pane (tokens.css V1).
    const block =
      /@media not \(prefers-reduced-transparency: reduce\)\s*\{([\s\S]*?)\n\}/.exec(
        chatCss
      )?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(
      /html:is\(\[data-platform="darwin"\], \[data-platform="win32"\]\)\[data-titlebar="overlay"\]:not\(\[data-translucency="off"\]\)\s*\[data-slot="composer-surface"\] \{\s*background-color: color-mix\(in oklab, var\(--chat-surface\) \d+%, transparent\);[\s\S]*?backdrop-filter: blur\(/
    );
  });
});
