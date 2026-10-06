/**
 * The bot identity's two homes (spec 03 §16.2): the transcript header and
 * the title-bar dock are one element. Exactly one copy is accessible at a
 * time and carries the cross-route view-transition name; the scroll-linked
 * morph is a named scroll timeline the title bar reads through the shell's
 * `timeline-scope`, with a reduced-motion cut; clicking either copy opens or
 * closes the details panel, and the title bar has no separate Details
 * action any more.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

// Read from disk: the pipeline passes only tokens.css through `?raw`.
const nodeFs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: "node:fs"): unknown };
  }
).process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const botsCss = nodeFs.readFileSync(
  `${(import.meta as ImportMeta & { dirname: string }).dirname}/../bots.css`,
  "utf8"
);

type Callback = (entries: IntersectionObserverEntry[]) => void;
const observers: Array<{ callback: Callback; targets: Element[] }> = [];
class FakeIntersectionObserver {
  private readonly record: { callback: Callback; targets: Element[] };
  constructor(callback: Callback) {
    this.record = { callback, targets: [] };
    observers.push(this.record);
  }
  observe(target: Element) {
    this.record.targets.push(target);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  observers.splice(0);
  vi.unstubAllGlobals();
});

const docked = () =>
  document.querySelector<HTMLElement>('[data-slot="bot-docked-identity"]')!;
const header = () =>
  document.querySelector<HTMLElement>('[data-slot="bot-transcript-identity"]')!;
const named = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[style]")).filter(
    (el) => el.style.viewTransitionName === "bot-identity-chief-of-staff"
  );

/** The header's observer reports it scrolled out (ratio 0) or back (ratio 1). */
const scrollHeader = (ratio: number) => {
  const target = header().querySelector("[style]")!;
  const entry = observers.find((o) => o.targets.includes(target));
  expect(entry).toBeDefined();
  act(() => {
    entry!.callback([
      { target, intersectionRatio: ratio } as IntersectionObserverEntry,
    ]);
  });
};

describe("the bot identity's shared-element morph", () => {
  it("keeps one accessible copy, which carries the view-transition name", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    app = await renderApp("/bots/chief-of-staff");
    await screen.findByTestId("bot-chat");
    // At the top: the header is the element; the dock is hidden.
    expect(header().hasAttribute("data-docked")).toBe(false);
    expect(docked().getAttribute("aria-hidden")).toBe("true");
    expect(docked().tabIndex).toBe(-1);
    expect(
      screen.getAllByRole("button", { name: "Details for Chief of Staff" })
    ).toHaveLength(1);
    expect(named()).toHaveLength(1);
    expect(header().contains(named()[0]!)).toBe(true);
    // The transcript's viewport names the timeline the title bar reads.
    expect(
      document
        .querySelector('[data-slot="message-scroller-viewport"]')
        ?.hasAttribute("data-identity-timeline")
    ).toBe(true);

    scrollHeader(0);
    await waitFor(() =>
      expect(docked().getAttribute("aria-hidden")).toBe("false")
    );
    expect(docked().tabIndex).toBe(0);
    expect(header().hasAttribute("data-docked")).toBe(true);
    expect(
      screen.getAllByRole("button", { name: "Details for Chief of Staff" })
    ).toHaveLength(1);
    expect(named()).toHaveLength(1);
    expect(docked().contains(named()[0]!)).toBe(true);

    scrollHeader(1);
    await waitFor(() =>
      expect(docked().getAttribute("aria-hidden")).toBe("true")
    );
    expect(header().contains(named()[0]!)).toBe(true);
  });

  it("drives the morph from the transcript's scroll timeline, scoped at the shell, with a reduced-motion cut", () => {
    expect(botsCss).toMatch(
      /\[data-slot="shell"\] \{ timeline-scope: --chat-transcript; \}/
    );
    expect(botsCss).toMatch(
      /\[data-slot="message-scroller-viewport"\]\[data-identity-timeline\] \{ scroll-timeline-name: --chat-transcript; \}/
    );
    const supports =
      /@supports \(animation-timeline: scroll\(\)\)\s*\{([\s\S]*?)\n\}/.exec(
        botsCss
      )?.[1];
    expect(supports).toBeDefined();
    expect(supports).toMatch(
      /\[data-slot="bot-transcript-identity"\] \{[^}]*animation: bot-identity-leave linear both;[^}]*animation-timeline: --chat-transcript;/
    );
    expect(supports).toMatch(
      /\[data-slot="bot-docked-identity"\] \{[^}]*animation: bot-identity-dock linear both;[^}]*animation-timeline: --chat-transcript;/
    );
    // The header shrinks towards the title bar's corner; the dock rises in.
    expect(botsCss).toMatch(
      /@keyframes bot-identity-leave \{\s*to \{ opacity: 0; translate: calc\(-50cqi \+ 24px\) -8px; scale: 0\.4; \}/
    );
    expect(botsCss).toMatch(
      /@keyframes bot-identity-dock \{\s*from \{ opacity: 0;/
    );
    // Reduced motion, resolved the way the foundation does.
    expect(botsCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?html:not\(\[data-reduce-motion="off"\]\) \[data-slot="bot-transcript-identity"\] \{ animation: none !important; \}/
    );
    expect(botsCss).toMatch(
      /html\[data-reduce-motion="on"\] \[data-slot="bot-docked-identity"\] \{ transition: none !important; animation: none !important; \}/
    );
  });

  it("opens and closes the details panel from either copy; no Details action in the bar", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    app = await renderApp("/bots/chief-of-staff");
    await screen.findByTestId("bot-chat");
    const search = () => app!.router.state.location.search as { tab?: string };
    expect(
      document.querySelector('[data-slot="topbar-actions"]')?.textContent ?? ""
    ).not.toContain("Details");
    expect(search().tab).toBeUndefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Chief of Staff" })
    );
    await waitFor(() => expect(search().tab).toBe("details"));
    await waitFor(() =>
      expect(
        header().querySelector("button")?.getAttribute("aria-expanded")
      ).toBe("true")
    );
    expect(docked().getAttribute("aria-expanded")).toBe("true");
    // Scrolled away, the docked copy is the toggle.
    scrollHeader(0);
    await waitFor(() =>
      expect(docked().getAttribute("aria-hidden")).toBe("false")
    );
    fireEvent.click(docked());
    await waitFor(() => expect(search().tab).toBeUndefined());
    expect(docked().getAttribute("aria-expanded")).toBe("false");
    // The far-right panel toggle stays.
    expect(screen.getByTestId("panel-toggle")).toBeTruthy();
  });
});
