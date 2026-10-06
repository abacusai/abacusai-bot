/**
 * The bot identity is one element (spec 03 §16.2): it lays out in the title
 * bar's slot and its parts travel to the transcript header's measured
 * offsets over the transcript's scroll timeline, which the shell scopes. The
 * header keeps its height with an invisible stand-in; reduced motion and
 * missing support cut between the states with a fade; clicking the element
 * toggles the details panel in both states; the avatar carries the
 * cross-route view-transition name once.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { measureIdentity } from "./identity";

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

const identity = () =>
  document.querySelector<HTMLButtonElement>('[data-slot="bot-identity"]')!;
const standIn = () =>
  document.querySelector<HTMLElement>('[data-slot="bot-identity-stand-in"]')!;
const named = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[style]")).filter(
    (el) => el.style.viewTransitionName === "bot-identity-chief-of-staff"
  );
const rect = (x: number, y: number, width: number, height: number) =>
  ({
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
  }) as DOMRect;

/** The stand-in's avatar scrolls out (ratio 0) or back in (ratio 1). */
const scrollHeader = (ratio: number) => {
  const target = standIn().querySelector('[data-part="avatar"]')!;
  const entry = observers.find((o) => o.targets.includes(target));
  expect(entry).toBeDefined();
  act(() => {
    entry!.callback([
      { target, intersectionRatio: ratio } as IntersectionObserverEntry,
    ]);
  });
};

describe("the bot identity, one element with two homes", () => {
  it("is one button that travels, with the stand-in keeping the header's height", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    app = await renderApp("/bots/chief-of-staff");
    await screen.findByTestId("bot-chat");
    expect(
      document.querySelectorAll('[data-slot="bot-identity"]')
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Details for Chief of Staff" })
    ).toHaveLength(1);
    // Its home is the title bar's identity slot; the stand-in is layout only.
    expect(identity().closest('[data-slot="topbar-identity"]')).not.toBeNull();
    expect(identity().hasAttribute("data-travels")).toBe(true);
    expect(identity().hasAttribute("data-docked")).toBe(false);
    expect(identity().tabIndex).toBe(0);
    expect(standIn().classList.contains("invisible")).toBe(true);
    expect(standIn().getAttribute("aria-hidden")).toBe("true");
    expect(standIn().hasAttribute("inert")).toBe(true);
    expect(standIn().querySelector("button")).toBeNull();
    // The avatar carries the route-transition name, once, in both states.
    expect(named()).toHaveLength(1);
    expect(named()[0]!.dataset.part).toBe("avatar");
    expect(identity().contains(named()[0]!)).toBe(true);
    // The transcript's viewport names the timeline the title bar reads.
    expect(
      document
        .querySelector('[data-slot="message-scroller-viewport"]')
        ?.hasAttribute("data-identity-timeline")
    ).toBe(true);

    scrollHeader(0);
    await waitFor(() =>
      expect(identity().hasAttribute("data-docked")).toBe(true)
    );
    expect(
      screen.getAllByRole("button", { name: "Details for Chief of Staff" })
    ).toHaveLength(1);
    expect(named()).toHaveLength(1);
    expect(identity().tabIndex).toBe(0);
    scrollHeader(1);
    await waitFor(() =>
      expect(identity().hasAttribute("data-docked")).toBe(false)
    );
  });

  it("writes each part's header offset and scale from the measured rects", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    app = await renderApp("/bots/chief-of-staff");
    await screen.findByTestId("bot-chat");
    const element = identity();
    const ghost = standIn();
    // The slot's rect (the element never transforms itself) and the
    // stand-in's parts at scroll 0; jsdom has no layout, so stub both.
    element.getBoundingClientRect = () => rect(300, 9, 180, 22);
    const stub = (root: Element, part: string, r: DOMRect, extra = {}) => {
      const el = root.querySelector<HTMLElement>(`[data-part="${part}"]`)!;
      el.getBoundingClientRect = () => r;
      Object.defineProperties(el, extra);
    };
    stub(ghost, "avatar", rect(472, 128, 56, 56));
    stub(ghost, "name", rect(455, 188, 90, 20));
    stub(ghost, "status", rect(440, 212, 120, 16));
    const offsets = (left: number, width: number, height: number) => ({
      offsetLeft: { value: left },
      offsetTop: { value: 0 },
      offsetWidth: { value: width },
      offsetHeight: { value: height },
    });
    stub(element, "avatar", rect(0, 0, 0, 0), offsets(4, 22, 22));
    stub(element, "name", rect(0, 0, 0, 0), offsets(34, 80, 18));
    stub(element, "status", rect(0, 0, 0, 0), offsets(122, 100, 16));
    const sizes = new Map<Element, string>([
      [ghost.querySelector('[data-part="name"]')!, "15px"],
      [element.querySelector('[data-part="name"]')!, "13px"],
      [ghost.querySelector('[data-part="status"]')!, "12px"],
      [element.querySelector('[data-part="status"]')!, "12px"],
    ]);
    const computed = window.getComputedStyle.bind(window);
    vi.stubGlobal("getComputedStyle", (el: Element) =>
      sizes.has(el)
        ? ({ fontSize: sizes.get(el) } as CSSStyleDeclaration)
        : computed(el)
    );
    act(() => measureIdentity(ghost, element));
    const vars = (part: string) => {
      const style = element.querySelector<HTMLElement>(
        `[data-part="${part}"]`
      )!.style;
      return [
        style.getPropertyValue("--bi-x"),
        style.getPropertyValue("--bi-y"),
        style.getPropertyValue("--bi-s"),
      ];
    };
    // Avatar: 56/22 about its top-left, centres aligned: 500 - (304 + 28), 156 - (9 + 28).
    expect(vars("avatar")).toEqual(["168px", "119px", "2.545"]);
    // Name: 15/13, centre 500 over 334 + 80 * 1.154 / 2.
    expect(vars("name")).toEqual(["119.85px", "178.62px", "1.154"]);
    // Status keeps its size and moves from beneath the name.
    expect(vars("status")).toEqual(["28px", "203px", "1"]);
    await waitFor(() =>
      expect(element.hasAttribute("data-measured")).toBe(true)
    );
  });

  it("drives the parts from the transcript's scroll timeline, scoped at the shell, and cuts with a fade otherwise", () => {
    expect(botsCss).toMatch(
      /\[data-slot="shell"\] \{ timeline-scope: --chat-transcript; \}/
    );
    expect(botsCss).toMatch(
      /\[data-slot="message-scroller-viewport"\]\[data-identity-timeline\] \{ scroll-timeline-name: --chat-transcript; \}/
    );
    // The resting state is the measured header offset; docked is zero.
    expect(botsCss).toMatch(
      /\[data-slot="bot-identity"\] > \[data-part\] \{\s*transform-origin: 0 0;\s*translate: var\(--bi-x, 0px\) var\(--bi-y, 0px\);\s*scale: var\(--bi-s, 1\);\s*will-change: transform;/
    );
    expect(botsCss).toMatch(
      /\[data-slot="bot-identity"\]\[data-docked\] > \[data-part\] \{ translate: 0 0; scale: 1; \}/
    );
    const supports =
      /@supports \(animation-timeline: scroll\(\)\)\s*\{([\s\S]*?)\n\}/.exec(
        botsCss
      )?.[1];
    expect(supports).toBeDefined();
    expect(supports).toMatch(
      /\[data-slot="bot-identity"\]\[data-travels\] > \[data-part\] \{\s*animation: bot-identity-travel linear both;\s*animation-timeline: --chat-transcript;\s*animation-range: 0px 120px;/
    );
    expect(supports).toMatch(
      /\[data-part="status"\] \{\s*animation-name: bot-identity-status-travel;/
    );
    expect(botsCss).toMatch(
      /@keyframes bot-identity-travel \{\s*from \{ translate: var\(--bi-x, 0px\) var\(--bi-y, 0px\); scale: var\(--bi-s, 1\); \}\s*to \{ translate: 0 0; scale: 1; \}/
    );
    expect(botsCss).toMatch(
      /@keyframes bot-identity-status-travel \{[\s\S]*?40% \{ opacity: 0; \}\s*60% \{ opacity: 0; \}/
    );
    // Reduced motion (OS and the pref) swaps the travel for a 120 ms cut.
    expect(botsCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*html:not\(\[data-reduce-motion="off"\]\) \[data-slot="bot-identity"\] > \[data-part\] \{ animation: none !important; \}\s*html:not\(\[data-reduce-motion="off"\]\) \[data-slot="bot-identity"\]\[data-travels\]\[data-docked\] \{ animation: bot-identity-cut-dock 120ms linear both; \}/
    );
    expect(botsCss).toMatch(
      /html\[data-reduce-motion="on"\] \[data-slot="bot-identity"\] > \[data-part\] \{ animation: none !important; \}/
    );
    expect(botsCss).toMatch(
      /html\[data-reduce-motion="on"\] \[data-slot="bot-identity"\]\[data-travels\]:not\(\[data-docked\]\) \{ animation: bot-identity-cut-header 120ms linear both; \}/
    );
    expect(botsCss).toMatch(
      /@supports not \(animation-timeline: scroll\(\)\) \{\s*\[data-slot="bot-identity"\]\[data-travels\]\[data-docked\] \{ animation: bot-identity-cut-dock 120ms linear both; \}/
    );
    expect(botsCss).toMatch(
      /@keyframes bot-identity-cut-dock \{ from \{ opacity: 0; \} \}/
    );
  });

  it("opens and closes the details panel in both states; no Details action in the bar", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    app = await renderApp("/bots/chief-of-staff");
    await screen.findByTestId("bot-chat");
    const search = () => app!.router.state.location.search as { tab?: string };
    expect(
      document.querySelector('[data-slot="topbar-actions"]')?.textContent ?? ""
    ).not.toContain("Details");
    expect(search().tab).toBeUndefined();
    expect(identity().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(identity());
    await waitFor(() => expect(search().tab).toBe("details"));
    await waitFor(() =>
      expect(identity().getAttribute("aria-expanded")).toBe("true")
    );
    // Docked, the same button is the toggle.
    scrollHeader(0);
    await waitFor(() =>
      expect(identity().hasAttribute("data-docked")).toBe(true)
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Chief of Staff" })
    );
    await waitFor(() => expect(search().tab).toBeUndefined());
    expect(identity().getAttribute("aria-expanded")).toBe("false");
    // The far-right panel toggle stays.
    expect(screen.getByTestId("panel-toggle")).toBeTruthy();
  });
});
