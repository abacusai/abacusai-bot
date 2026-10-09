/**
 * R2-T16, jsdom half (spec 02 §10): message ids and user anchors on rows,
 * `aria-busy` while a run is active, timestamps from `createdAt` or
 * `metadata.tanstack.createdAt`, day separators, paging (a page after a
 * reset is discarded, ids deduplicated, older outcomes merged), and the
 * bounded window: repeated "Show earlier" never mounts more than MAX_ROWS.
 * (First-paint `data-pending-scroll` and pixel anchoring are the Electron
 * half, not run here.)
 */
import type { UIMessage } from "@tanstack/ai-client";
import { act, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageScrollerProvider } from "#renderer/ui/message-scroller";
import * as scroller from "#renderer/ui/message-scroller";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { ChatViewProvider, createInlineRegistry } from "../kit/context";
import { createChatRuntime } from "../runtime/runtime";
import { ThreadSession } from "../runtime/session";
import { renderRelay, renderWithDb } from "../testing";
import { useToolWindow } from "./row-context";
import { Transcript } from "./transcript";
import {
  dayKey,
  followWindow,
  MAX_ROWS,
  mountedRows,
  moreSteps,
  messageTime,
  newestWindow,
  showEarlier,
  showLater,
} from "./window";

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
    return [
      b.runStarted(`r${i}`, { timestamp: 1_700_000_000_000 + i * 3_600_000 }),
      ...b.text(`u${i}`, "user", `question ${i}`),
      ...b.text(`a${i}`, "assistant", `answer ${i}`),
      b.runFinished(`r${i}`),
    ];
  }).flat();

describe("R2-T16 window (pure)", () => {
  it("never exceeds MAX_ROWS in either direction", () => {
    const items = Array.from({ length: 3000 }, (_, i) => ({
      id: String(i),
      fixed: 1,
      units: 0,
    }));
    let window = newestWindow(items);
    expect(window.end - window.start).toBe(MAX_ROWS);
    for (let i = 0; i < 10; i += 1) {
      window = showEarlier(items, window);
      expect(window.end - window.start).toBeLessThanOrEqual(MAX_ROWS);
    }
    expect(window.start).toBe(3000 - MAX_ROWS - 250);
    for (let i = 0; i < 10; i += 1) window = showLater(items, window);
    expect(window).toEqual({ start: 3000 - MAX_ROWS, end: 3000, ranges: {} });
    expect(
      followWindow(
        { start: 10, end: 410, ranges: {} },
        410,
        items.slice(0, 420),
        0
      )
    ).toEqual({
      start: 420 - MAX_ROWS,
      end: 420,
      ranges: {},
    });
    expect(
      followWindow(
        { start: 10, end: 200, ranges: {} },
        410,
        items.slice(0, 460),
        50
      )
    ).toEqual({
      start: 60,
      end: Math.min(250, 60 + MAX_ROWS),
      ranges: {},
    });
  });

  it("times from createdAt or metadata.tanstack.createdAt; none starts no day", () => {
    expect(messageTime({ createdAt: new Date(5) })?.getTime()).toBe(5);
    expect(
      messageTime({
        metadata: { tanstack: { createdAt: "2026-09-01T10:00:00.000Z" } },
      })?.toISOString()
    ).toBe("2026-09-01T10:00:00.000Z");
    expect(messageTime({})).toBeNull();
    expect(dayKey(null)).toBeNull();
  });
});

describe("R2-T16 transcript", () => {
  it("keeps completed row context stable during streaming and pages with current ranges", async () => {
    const past: UIMessage = {
      id: "past",
      role: "assistant",
      parts: Array.from({ length: 100 }, (_, i) => ({
        type: "tool-call" as const,
        id: `tool-${i}`,
        name: "bash",
        arguments: "{}",
        state: "complete" as const,
      })),
    };
    const live: UIMessage = {
      id: "live",
      role: "assistant",
      parts: [{ type: "text", content: "First" }],
    };
    const runtime = createChatRuntime(new FakeRelay().ai);
    const session = runtime.session("test-transcript");
    const context = {
      threadId: session.threadId,
      skin: "session" as const,
      session,
      runtime,
      composer: {
        mode: "full" as const,
        placeholder: "",
        attachmentsBase: null,
        showModeChip: false,
        model: null,
      },
      slots: {},
      workspaceRoot: null,
      focused: true,
      notchEnabled: false,
      inline: createInlineRegistry(),
    };
    const rendered = vi.fn();
    const Message = ({ message }: { message: UIMessage }) => {
      const window = useToolWindow()!;
      rendered(message.id, window);
      return message.id === "past" ? (
        <button onClick={window.more}>More {window.range.end}</button>
      ) : (
        <span>
          {message.parts
            .flatMap((part) => (part.type === "text" ? [part.content] : []))
            .join("")}
        </span>
      );
    };
    const tree = (messages: UIMessage[]) => (
      <ChatViewProvider value={context}>
        <MessageScrollerProvider>
          <Transcript messages={messages} Message={Message} />
        </MessageScrollerProvider>
      </ChatViewProvider>
    );
    const view = await renderWithDb(tree([past, live]));
    try {
      const previous = rendered.mock.calls.filter(([id]) => id === "past");
      await view.rerender(
        tree([
          past,
          { ...live, parts: [{ type: "text", content: "First token" }] },
        ])
      );
      expect(screen.getByText("First token")).toBeTruthy();
      expect(rendered.mock.calls.filter(([id]) => id === "past")).toEqual(
        previous
      );
      fireEvent.click(screen.getByRole("button", { name: "More 50" }));
      expect(screen.getByRole("button", { name: "More 75" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "More 75" }));
      expect(screen.getByRole("button", { name: "More 100" })).toBeTruthy();
    } finally {
      await view.cleanup();
      runtime.forget(session.threadId);
    }
  });

  it("filters hidden bot messages before allocating transcript rows", async () => {
    const relay = new FakeRelay();
    relay.emitAll([...b.sessionReady(), ...turns(2)]);
    current = await renderRelay(
      relay,
      "bot",
      {},
      {
        slots: { isMessageHidden: (message) => message.id === "a0" },
      }
    );
    await screen.findByText("answer 1");
    expect(document.querySelector('[data-message-id="a0"]')).toBeNull();
    expect(document.querySelector('[data-message-id="a1"]')).not.toBeNull();
  });

  it("rows carry message ids, users anchor, the log is busy while a run is active", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      ...turns(2),
      b.runStarted("live"),
      ...b.text("u-live", "user", "go"),
    ]);
    current = await renderRelay(relay, "session");
    await screen.findByText("go");
    const user = document.querySelector('[data-message-id="u0"]')!;
    expect(user.getAttribute("data-scroll-anchor")).toBe("true");
    expect(
      document
        .querySelector('[data-message-id="a0"]')!
        .getAttribute("data-scroll-anchor")
    ).toBe("false");
    expect(screen.getByRole("log").getAttribute("aria-busy")).toBe("true");
    expect(
      document.querySelectorAll('[data-slot="day-separator"]').length
    ).toBeGreaterThan(0);
  });

  it("marks only messages that arrive while it is open as fresh, never on remount", async () => {
    const relay = new FakeRelay();
    relay.emitAll([...b.sessionReady(), ...turns(1)]);
    current = await renderRelay(relay, "bot");
    await screen.findByText("answer 0");
    expect(document.querySelectorAll("[data-fresh]").length).toBe(0);
    relay.emitAll([
      b.runStarted("r-late"),
      ...b.text("u-late", "user", "one more"),
      ...b.text("a-late", "assistant", "late answer"),
      b.runFinished("r-late"),
    ]);
    await screen.findByText("late answer");
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-message-id="a-late"]')
          ?.hasAttribute("data-fresh")
      ).toBe(true)
    );
    // Back into the thread: the same rows are history to the new transcript.
    await current.remount();
    await screen.findByText("late answer");
    expect(document.querySelectorAll("[data-fresh]").length).toBe(0);
  });

  it("Show earlier mounts older rows without passing the budget", async () => {
    const items = [{ id: "huge", fixed: 1, units: 3000 }];
    let window = newestWindow(items);
    for (let i = 0; i < 10; i += 1) {
      window = moreSteps(items, window, "huge");
      expect(mountedRows(items, window)).toBeLessThanOrEqual(MAX_ROWS);
    }
    expect(window.ranges.huge!.end).toBe(300);
    expect(window.ranges.huge!.start).toBeGreaterThan(0);
  });

  it("preloads an older page near the viewport without replacing the mounted messages", async () => {
    const observers: {
      callback: IntersectionObserverCallback;
      options?: IntersectionObserverInit;
      target?: Element;
    }[] = [];
    const original = globalThis.IntersectionObserver;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        entry: (typeof observers)[number];
        constructor(
          callback: IntersectionObserverCallback,
          options?: IntersectionObserverInit
        ) {
          this.entry = { callback, options };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        unobserve() {}
        disconnect() {}
      }
    );
    try {
      const relay = new FakeRelay();
      relay.emitAll([...b.sessionReady(), ...turns(40)]);
      current = await renderRelay(relay, "session");
      const session = current.runtime.session(relay.threadId);
      const older = vi.spyOn(session, "loadOlder");
      const sentinel = observers.find(
        (observer) => observer.options?.rootMargin === "640px 0px 0px"
      );
      expect(sentinel?.options?.root).toBe(
        document.querySelector('[data-slot="message-scroller-viewport"]')
      );
      const before = document.querySelector("[data-message-id]");
      await act(async () =>
        sentinel!.callback(
          [
            {
              isIntersecting: true,
              target: sentinel!.target!,
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        )
      );
      expect(older).toHaveBeenCalledOnce();
      expect(before?.isConnected).toBe(true);
      expect(
        document.querySelector(
          '[data-slot="message-scroller-viewport"] [data-slot="skeleton"]'
        )
      ).toBeNull();
    } finally {
      vi.stubGlobal("IntersectionObserver", original);
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
    await waitFor(() =>
      expect(relay.stats.subscribe).toBeGreaterThanOrEqual(2)
    );
    let release!: () => void;
    relay.faults.hydrate = () =>
      new Promise<void>((resolve) => (release = resolve));
    const page = second.loadOlder();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    relay.faults.hydrate = undefined;
    relay.emit(b.custom("session.cleared", {}));
    await waitFor(() => expect(second.rev).toBe(1));
    release();
    await page;
    await second.load();
    expect(second.hostStore.state.messages).toEqual([]);
  });
});

describe("group rows share the tool budget", () => {
  it("hundreds of separate migrated groups cannot become fixed, unbounded rows", async () => {
    const { toolRows } = await import("./row-context");
    const parts = Array.from({ length: 300 }, (_, i) => ({
      type: "tool-call" as const,
      id: `tool-${i}`,
      name: "bash",
      arguments: "{}",
      state: "complete" as const,
    }));
    const message = {
      id: "grouped",
      role: "assistant" as const,
      parts,
      metadata: {
        abacus: {
          segments: parts.map((_, i) => ({
            type: "tool_call",
            id: `segment-${i}`,
            partIndex: i,
            groupId: `group-${i}`,
          })),
        },
      },
    };
    const units = toolRows(message);
    expect(units).toHaveLength(600);
    expect(units.slice(0, 4)).toEqual([
      "group\0\0grouped\0group-0",
      "\0tool-0",
      "group\0\0grouped\0group-1",
      "\0tool-1",
    ]);
    const items = [{ id: message.id, fixed: 1, units: units.length }];
    let window = newestWindow(items);
    for (let i = 0; i < 10; i++) {
      window = moreSteps(items, window, message.id);
      expect(mountedRows(items, window)).toBeLessThanOrEqual(MAX_ROWS);
    }
  });
});

describe("r2 pageable message units", () => {
  it("tool results stay paired with their calls when the mounted window advances", async () => {
    const parts: UIMessage["parts"] = [];
    for (let index = 0; index < 150; index += 1) {
      parts.push(
        {
          type: "tool-call",
          id: `paired-${index}`,
          name: "bash",
          arguments: JSON.stringify({ command: `step-${index}` }),
          state: "complete",
        },
        {
          type: "tool-result",
          toolCallId: `paired-${index}`,
          content: JSON.stringify({
            text: `result-${index}`,
            terminal: { output: `result-${index}` },
          }),
          state: "complete",
        }
      );
    }
    current = await renderRelay(
      new FakeRelay({ history: [{ id: "paired", role: "assistant", parts }] }),
      "session"
    );
    fireEvent.click(await screen.findByRole("button", { name: /step-0\b/ }));
    expect(await screen.findByText("result-0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /more steps/i }));
    fireEvent.click(screen.getByRole("button", { name: /more steps/i }));
    fireEvent.click(await screen.findByRole("button", { name: /step-70\b/ }));
    expect(await screen.findByText("result-70")).toBeTruthy();
    expect(screen.queryByText("result-0")).toBeNull();
    expect(
      document
        .querySelector("[data-tool] [data-status]")
        ?.getAttribute("data-status")
    ).toBe("done");
    expect(
      document.querySelectorAll(
        '[data-tool], [data-slot="message-scroller-item"]'
      ).length
    ).toBeLessThanOrEqual(MAX_ROWS);
  });

  it("a closed migrated tool group remains accessible after its header is evicted", async () => {
    const parts = Array.from({ length: 250 }, (_, i) => ({
      type: "tool-call" as const,
      id: `tool-${i}`,
      name: "bash",
      arguments: JSON.stringify({ command: `step-${i}` }),
      state: "complete" as const,
    }));
    const message = {
      id: "large-group",
      role: "assistant" as const,
      parts,
      metadata: {
        abacus: {
          segments: [
            {
              id: "large",
              type: "tool_group",
              summary: "Migrated tools",
              partIndex: null,
            },
            ...parts.map((_, i) => ({
              id: `s-${i}`,
              type: "tool_call",
              partIndex: i,
              groupId: "large",
            })),
          ],
        },
      },
    };
    current = await renderRelay(
      new FakeRelay({ history: [message] }),
      "session"
    );
    const header = await screen.findByRole("button", {
      name: "Migrated tools",
    });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /more steps/i }));
    fireEvent.click(screen.getByRole("button", { name: /more steps/i }));
    await waitFor(() =>
      expect(document.querySelectorAll("[data-tool]").length).toBeGreaterThan(0)
    );
    for (let i = 0; i < 7; i++) {
      const more = screen.queryByRole("button", { name: /more steps/i });
      if (more) fireEvent.click(more);
      expect(
        document.querySelectorAll(
          '[data-tool], [data-slot="tool-group"] > button:not([hidden]), [data-slot="message-scroller-item"]'
        ).length
      ).toBeLessThanOrEqual(MAX_ROWS);
    }
    expect(screen.queryByRole("button", { name: /more steps/i })).toBeNull();
    expect(document.querySelectorAll("[data-tool]").length).toBeGreaterThan(0);
  });

  it.each(["session", "bot"] as const)(
    "%s pages 150 top-level subagents inside one message",
    async (skin) => {
      const parts = Array.from({ length: 150 }, (_, i) => ({
        type: "subagent" as const,
        subagent: {
          id: `child-${i}`,
          name: "general",
          description: `Child ${i}`,
          status: "finished" as const,
          messages: [],
        },
      }));
      current = await renderRelay(
        new FakeRelay({ history: [{ id: "cards", role: "assistant", parts }] }),
        skin
      );
      await screen.findByText("Child 0");
      const count = () =>
        document.querySelectorAll(
          '[data-slot="subagent-row"], [data-slot="message-scroller-item"]'
        ).length;
      expect(count()).toBeLessThanOrEqual(MAX_ROWS);
      for (let i = 0; i < 4; i++) {
        fireEvent.click(screen.getByRole("button", { name: /more steps/i }));
        expect(count()).toBeLessThanOrEqual(MAX_ROWS);
      }
      await screen.findByText("Child 149");
      expect(count()).toBeLessThanOrEqual(MAX_ROWS);
      expect(screen.queryByText("Child 0")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /earlier steps/i }));
      expect(count()).toBeLessThanOrEqual(MAX_ROWS);
    }
  );
});

it("retains the selected DOM row while the moving window pages away", async () => {
  const relay = new FakeRelay();
  const retained = vi
    .spyOn(ThreadSession.prototype, "retain")
    .mockImplementation(() => {});
  relay.emitAll([...b.sessionReady(), ...turns(500)]);
  current = await renderRelay(relay, "bot");
  const session = current.runtime.session(relay.threadId);
  await act(async () => {
    for (let i = 0; i < 20; i++) await session.loadOlder();
  });
  const row = document.querySelector('[data-message-id="a499"]')!;
  const text = row.querySelector<HTMLElement>("[data-message-text]")!;
  fireEvent.pointerDown(text, { button: 0 });
  text.focus();
  fireEvent.keyDown(text, { key: "a", metaKey: true });
  fireEvent(document, new Event("selectionchange"));
  fireEvent.pointerUp(document);
  for (let i = 0; i < 5; i++) {
    const earlier = screen.queryByRole("button", { name: /Show earlier/ });
    if (!earlier) break;
    fireEvent.click(earlier);
  }
  expect(row.isConnected).toBe(true);
  expect(document.getSelection()!.toString()).toContain("answer 499");
  document.getSelection()!.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));

  await waitFor(() => expect(row.isConnected).toBe(false));
  retained.mockRestore();
});

it("loads history when the spacer intersects, even if its centered button is outside view", async () => {
  const observers: {
    callback: IntersectionObserverCallback;
    options?: IntersectionObserverInit;
    target?: Element;
  }[] = [];
  const original = globalThis.IntersectionObserver;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: (typeof observers)[number];
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit
      ) {
        this.entry = { callback, options };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      unobserve() {}
      disconnect() {}
    }
  );
  const away = vi
    .spyOn(scroller, "useMessageScrollerScrollable")
    .mockReturnValue({ start: true, end: true });
  try {
    const relay = new FakeRelay();
    relay.emitAll([...b.sessionReady(), ...turns(80)]);
    current = await renderRelay(relay, "session");
    const session = current.runtime.session(relay.threadId);
    await act(async () => {
      for (let i = 0; i < 3; i++) await session.loadOlder();
    });
    const viewport = document.querySelector(
      '[data-slot="message-scroller-viewport"]'
    )!;
    const first = viewport
      .querySelector("[data-message-id]")!
      .getAttribute("data-message-id");
    const observer = observers.findLast(
      (entry) =>
        entry.options?.rootMargin === "400px 0px" &&
        entry.target?.isConnected &&
        entry.target.textContent?.includes("Show earlier")
    );
    expect(observer?.target?.parentElement).toBe(viewport);
    expect(
      observer?.target?.querySelector('[data-slot="window-placeholder"]')
    ).not.toBeNull();
    await act(async () =>
      observer!.callback(
        [
          {
            isIntersecting: true,
            target: observer!.target!,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      )
    );
    expect(
      viewport
        .querySelector("[data-message-id]")!
        .getAttribute("data-message-id")
    ).not.toBe(first);
    expect(
      viewport.querySelectorAll('[data-slot="message-scroller-item"]').length
    ).toBeLessThanOrEqual(MAX_ROWS);
  } finally {
    away.mockRestore();
    vi.stubGlobal("IntersectionObserver", original);
  }
});
