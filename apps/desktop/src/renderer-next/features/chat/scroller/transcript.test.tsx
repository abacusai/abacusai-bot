/**
 * R2-T16, jsdom half (spec 02 §10): message ids and user anchors on rows,
 * `aria-busy` while a run is active, timestamps from `createdAt` or
 * `metadata.tanstack.createdAt`, day separators, paging (a page after a
 * reset is discarded, ids deduplicated, older outcomes merged), and the
 * bounded window: repeated "Show earlier" never mounts more than MAX_ROWS.
 * (First-paint `data-pending-scroll` and pixel anchoring are the Electron
 * half, not run here.)
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { ThreadSession } from "../runtime/session";
import { renderRelay } from "../testing";
import { dayKey, followWindow, MAX_ROWS, messageTime, newestWindow, showEarlier, showLater } from "./window";

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
const sessions: ThreadSession[] = [];
afterEach(async () => {
  await current?.cleanup();
  current = null;
  for (const session of sessions.splice(0)) session.retire();
});

const turns = (count: number, start = 0) =>
  Array.from({ length: count }, (_, index) => {
    const i = start + index;
    return [b.runStarted(`r${i}`, { timestamp: 1_700_000_000_000 + i * 3_600_000 }), ...b.text(`u${i}`, "user", `question ${i}`), ...b.text(`a${i}`, "assistant", `answer ${i}`), b.runFinished(`r${i}`)];
  }).flat();

describe("R2-T16 window (pure)", () => {
  it("never exceeds MAX_ROWS in either direction", () => {
    let window = newestWindow(3000);
    expect(window.end - window.start).toBe(MAX_ROWS);
    for (let i = 0; i < 10; i += 1) {
      window = showEarlier(window);
      expect(window.end - window.start).toBeLessThanOrEqual(MAX_ROWS);
    }
    expect(window.start).toBe(3000 - MAX_ROWS - 1000);
    for (let i = 0; i < 10; i += 1) window = showLater(window, 3000);
    expect(window).toEqual({ start: 3000 - MAX_ROWS, end: 3000 });
    expect(followWindow({ start: 10, end: 410 }, 410, 420, 0)).toEqual({ start: 20, end: 420 });
    expect(followWindow({ start: 10, end: 200 }, 410, 460, 50)).toEqual({ start: 60, end: 250 });
  });

  it("times from createdAt or metadata.tanstack.createdAt; none starts no day", () => {
    expect(messageTime({ createdAt: new Date(5) })?.getTime()).toBe(5);
    expect(messageTime({ metadata: { tanstack: { createdAt: "2026-09-01T10:00:00.000Z" } } })?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(messageTime({})).toBeNull();
    expect(dayKey(null)).toBeNull();
  });
});

describe("R2-T16 transcript", () => {
  it("rows carry message ids, users anchor, the log is busy while a run is active", async () => {
    const relay = new FakeRelay();
    relay.emitAll([...b.sessionReady(), ...turns(2), b.runStarted("live"), ...b.text("u-live", "user", "go")]);
    current = await renderRelay(relay, "session");
    await screen.findByText("go");
    const user = document.querySelector('[data-message-id="u0"]')!;
    expect(user.getAttribute("data-scroll-anchor")).toBe("true");
    expect(document.querySelector('[data-message-id="a0"]')!.getAttribute("data-scroll-anchor")).toBe("false");
    expect(screen.getByRole("log").getAttribute("aria-busy")).toBe("true");
    expect(document.querySelectorAll('[data-slot="day-separator"]').length).toBeGreaterThan(0);
  });

  it("Show earlier mounts older rows without passing the budget", async () => {
    const relay = new FakeRelay();
    relay.emitAll([...b.sessionReady(), ...turns(260)]);
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    // Page everything in, then render.
    await session.load();
    while (session.hostStore.state.hasOlderMessages) await session.loadOlder();
    expect(session.hostStore.state.messages).toHaveLength(520);
    current = await renderRelay(relay, "session");
    // A fresh session in the renderer's runtime: page it too.
    const view = current.runtime.session("t-1");
    while (view.hostStore.state.hasOlderMessages) await view.loadOlder();
    await waitFor(() => expect(document.querySelectorAll('[data-slot="message-scroller-item"][data-message-id]').length).toBe(MAX_ROWS));
    for (let i = 0; i < 3; i += 1) {
      const earlier = screen.queryByRole("button", { name: /Show earlier/ });
      if (earlier == null) break;
      fireEvent.click(earlier);
      expect(document.querySelectorAll('[data-slot="message-scroller-item"][data-message-id]').length).toBeLessThanOrEqual(MAX_ROWS);
    }
  });

  it("a page returned after a reset is discarded; pages merge outcomes and dedupe ids", async () => {
    const relay = new FakeRelay();
    relay.emitAll([...b.sessionReady(), ...turns(40)]);
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    const before = session.hostStore.state.messages.length;
    await session.loadOlder();
    const after = session.hostStore.state.messages;
    expect(after.length).toBeGreaterThan(before);
    expect(new Set(after.map((m) => m.id)).size).toBe(after.length);
    expect(session.store.state.runs.outcomes.length).toBe(40);

    const second = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(second);
    await second.load();
    let release!: () => void;
    relay.faults.hydrate = () => new Promise<void>((resolve) => (release = resolve));
    const page = second.loadOlder();
    relay.faults.hydrate = undefined;
    relay.emit(b.custom("session.cleared", {}));
    await waitFor(() => expect(second.rev).toBe(1));
    release();
    await page;
    await second.load();
    expect(second.hostStore.state.messages).toEqual([]);
  });
});
