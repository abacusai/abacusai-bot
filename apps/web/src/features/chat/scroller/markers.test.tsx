/** R2-T16 jsdom: pending insertion and unread markers through the real kit. */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

const scroll = vi.hoisted(() => ({ away: false }));
vi.mock("#renderer/ui/message-scroller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#renderer/ui/message-scroller")>()),
  useMessageScrollerScrollable: () => ({
    start: scroll.away,
    end: scroll.away,
  }),
  useMessageScrollerVisibility: () => ({
    currentAnchorId: null,
    visibleMessageIds: [],
  }),
}));
let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  scroll.away = false;
  vi.restoreAllMocks();
});
const initial = () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("r1"),
    ...b.text("u", "user", "hello"),
    ...b.text("a", "assistant", "old reply"),
    b.runFinished("r1"),
  ]);
  return relay;
};
describe("R2-T16 opening and unread rows", () => {
  it("inserts the viewport with data-pending-scroll before layout exposes it", async () => {
    const writes: Element[] = [];
    const original = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, "setAttribute").mockImplementation(
      function (this: Element, name, value) {
        if (name === "data-pending-scroll") writes.push(this);
        original.call(this, name, value);
      }
    );
    current = await renderRelay(initial(), "session");
    expect(
      writes.some(
        (el) => el.getAttribute("data-slot") === "message-scroller-viewport"
      )
    ).toBe(true);
    expect(await screen.findByText("old reply")).toBeTruthy();
  });

  it("marks new assistant messages while away and clears the marker for a local user echo", async () => {
    scroll.away = true;
    const relay = initial();
    current = await renderRelay(relay, "session");
    act(() =>
      relay.emitAll([
        b.runStarted("r2"),
        ...b.text("a2", "assistant", "new reply"),
      ])
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="new-marker"]')?.textContent
      ).toContain("1 new")
    );
    expect(screen.getByRole("button", { name: "1 new message" })).toBeTruthy();
    act(() => relay.emitAll(b.text("local", "user", "steer")));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="new-marker"]')).toBeNull()
    );
  });
  it("stubbed geometry preserves the first visible row when an older page mounts", async () => {
    scroll.away = true;
    const originalScrollTo = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTo"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: function (this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = options.top ?? this.scrollTop;
      },
    });
    onTestFinished(() => {
      if (originalScrollTo)
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollTo",
          originalScrollTo
        );
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.slot === "message-scroller-viewport" ? 200 : 0;
      }
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return (
          this.querySelectorAll('[data-slot="message-scroller-item"]').length *
          100
        );
      }
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.slot === "message-scroller-viewport")
          return new DOMRect(0, 0, 100, 200);
        if (this.dataset.slot === "message-scroller-item") {
          const v = this.closest<HTMLElement>(
            '[data-slot="message-scroller-viewport"]'
          );
          if (v != null)
            return new DOMRect(
              0,
              [
                ...v.querySelectorAll('[data-slot="message-scroller-item"]'),
              ].indexOf(this) *
                100 -
                v.scrollTop,
              100,
              100
            );
        }
        return new DOMRect(0, 0, 0, 0);
      }
    );
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      ...Array.from({ length: 40 }, (_, i) => [
        b.runStarted(`r${i}`),
        ...b.text(`u${i}`, "user", `question ${i}`),
        ...b.text(`a${i}`, "assistant", `answer ${i}`),
        b.runFinished(`r${i}`),
      ]).flat(),
    ]);
    current = await renderRelay(relay, "session");
    const viewport = document.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]'
    )!;
    viewport.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, bubbles: true })
    );
    viewport.scrollTop = 600;
    const anchor = [
      ...viewport.querySelectorAll<HTMLElement>(
        '[data-slot="message-scroller-item"]'
      ),
    ].find((el) => el.getBoundingClientRect().top === 0)!;
    const top = anchor.getBoundingClientRect().top;
    await act(async () => {
      await current!.runtime.session(relay.threadId).loadOlder();
    });
    await waitFor(() =>
      expect(
        Math.abs(anchor.getBoundingClientRect().top - top)
      ).toBeLessThanOrEqual(1)
    );
    expect(anchor.isConnected).toBe(true);
  });
});
