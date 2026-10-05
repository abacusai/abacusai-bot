/**
 * The chat bench (spec 02 §13, R2-T16 Electron half and R2-T31): a gallery
 * fixture (`/__ui?fixture=bench-<case>`) that mounts a real `ChatView` over a
 * `FakeRelay` holding a synthetic thread, the way a route does: it awaits
 * `session.load()` first (the loader), then commits the view. It records
 * what the Electron suite measures and exposes the session on
 * `window.__chatBench`. Dev-only (VITE_UI_GALLERY builds); lazily loaded.
 */
import type { StreamChunk } from "@tanstack/ai";
import { useEffect, useRef, useState } from "react";

import type { ComposerConfig } from "../../kit/context";
import { ChatView } from "../../kit/view";
import { inertHostActions } from "../../runtime/host-actions";
import { createChatRuntime, type ChatRuntime } from "../../runtime/runtime";
import type { ThreadSession } from "../../runtime/session";
import { FakeRelay } from "../relay";
import {
  activeReplay,
  hugeToolMessage,
  onlyActiveRun,
  richThread,
  streamingRun,
  type BenchThread,
} from "./threads";

interface BenchCase {
  thread: () => BenchThread;
  /** The first `ai.hydrate` waits this long. */
  hydrateDelayMs?: number;
  /** Every `ai.joinRun` waits this long before it replays. */
  joinDelayMs?: number;
}

const CASES: Record<string, BenchCase> = {
  "bench-rich": { thread: () => richThread() },
  "bench-replay": { thread: () => activeReplay() },
  "bench-tools": { thread: () => hugeToolMessage() },
  "bench-slow-hydrate": { thread: onlyActiveRun, hydrateDelayMs: 2000 },
  "bench-slow-join": { thread: onlyActiveRun, joinDelayMs: 2000 },
  "bench-stream": { thread: () => ({ history: [], events: [] }) },
};

interface Frame {
  /** ms since the view was committed. */
  t: number;
  viewport: boolean;
  pending: boolean;
  /** The last message row intersects the viewport. */
  lastInView: boolean;
  /** Text of the rows in view (first visible frame only). */
  text?: string;
}

interface BenchState {
  id: string;
  session: ThreadSession;
  relay: FakeRelay;
  runtime: ChatRuntime;
  /** Two concurrent `load()` callers got the same promise. */
  samePromise: boolean;
  /** ms from the first `load()` to readiness (the loader's wait). */
  loadMs: number | null;
  loadError: string | null;
  /** `performance.now()` when the view was committed. */
  mountedAt: number | null;
  /** The viewport's `data-pending-scroll` when it was inserted. */
  insertedPending: boolean | null;
  frames: Frame[];
  /** ms from commit to the frame after the first visible one (paint done). */
  firstPaintMs: number | null;
  rows(): { messages: number; tools: number; subagents: number; total: number };
  /** Streams R2-T31(d)'s 20 KB run; resolves when its terminal is applied. */
  stream(options?: { intervalMs?: number; bytes?: number }): Promise<number>;
}

type BenchWindow = Window & { __chatBench?: BenchState };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const ROWS = {
  messages: '[data-slot="message-scroller-item"]',
  tools: "[data-tool]",
  subagents: '[data-slot="subagent-row"]',
};

const countRows = (): ReturnType<BenchState["rows"]> => {
  const messages = document.querySelectorAll(ROWS.messages).length;
  const tools = document.querySelectorAll(ROWS.tools).length;
  const subagents = document.querySelectorAll(ROWS.subagents).length;
  return { messages, tools, subagents, total: messages + tools + subagents };
};

const intersects = (a: DOMRect, b: DOMRect): boolean =>
  a.bottom > b.top && a.top < b.bottom;

const COMPOSER: ComposerConfig = {
  mode: "full",
  placeholder: "Steer the run, or queue the next step",
  attachmentsBase: null,
  showModeChip: true,
  model: null,
};

const build = (id: string): BenchState => {
  const bench = CASES[id]!;
  const thread = bench.thread();
  const relay = new FakeRelay({
    threadId: id,
    history: thread.history,
    events: thread.events,
  });
  if (bench.hydrateDelayMs != null) {
    const delay = bench.hydrateDelayMs;
    relay.faults.hydrate = (call) => (call === 1 ? sleep(delay) : null);
  }
  if (bench.joinDelayMs != null) {
    const delay = bench.joinDelayMs;
    const join = relay.source.joinRun.bind(relay.source);
    (relay.source as { joinRun: unknown }).joinRun = async function* (
      ...args: Parameters<typeof join>
    ) {
      await sleep(delay);
      yield* join(...args);
    };
  }
  const runtime = createChatRuntime(relay.ai, { host: inertHostActions });
  const session = runtime.session(id);
  const state: BenchState = {
    id,
    session,
    relay,
    runtime,
    samePromise: false,
    loadMs: null,
    loadError: null,
    mountedAt: null,
    insertedPending: null,
    frames: [],
    firstPaintMs: null,
    rows: countRows,
    stream: async ({ intervalMs = 16, bytes = 20 * 1024 } = {}) => {
      const run = streamingRun(bytes);
      const emit = (events: readonly StreamChunk[]) => {
        for (const event of events) relay.emit(event);
      };
      emit(run.start);
      for (const delta of run.deltas) {
        relay.emit(delta);
        await sleep(intervalMs);
      }
      emit(run.end);
      const last = relay.lastSeq;
      for (let i = 0; i < 500; i += 1) {
        if ((session.positions()?.appliedSeq ?? 0) >= last) break;
        await sleep(10);
      }
      return run.deltas.length;
    },
  };
  return state;
};

/** Watches the committed view: insertion of the viewport, then 120 frames. */
const probe = (container: HTMLElement, state: BenchState): (() => void) => {
  const viewportOf = () =>
    container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]'
    );
  const observer = new MutationObserver((records) => {
    const viewport = viewportOf();
    if (viewport == null || state.insertedPending != null) return;
    state.insertedPending =
      viewport.hasAttribute("data-pending-scroll") ||
      records.some(
        (record) =>
          record.target === viewport &&
          record.attributeName === "data-pending-scroll" &&
          record.oldValue != null
      );
    observer.disconnect();
  });
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-pending-scroll"],
    attributeOldValue: true,
  });
  let frame = 0;
  let handle = 0;
  let visibleAt = -1;
  const tick = () => {
    const now = performance.now();
    const viewport = viewportOf();
    const record: Frame = {
      t: now - (state.mountedAt ?? now),
      viewport: viewport != null,
      pending: viewport?.hasAttribute("data-pending-scroll") ?? true,
      lastInView: false,
    };
    if (viewport != null) {
      const box = viewport.getBoundingClientRect();
      const items = viewport.querySelectorAll(ROWS.messages);
      const last = items[items.length - 1];
      record.lastInView =
        last != null && intersects(last.getBoundingClientRect(), box);
      if (!record.pending && visibleAt < 0) {
        visibleAt = frame;
        record.text = [...items]
          .filter((item) => intersects(item.getBoundingClientRect(), box))
          .map((item) => item.textContent ?? "")
          .join("\n")
          .slice(-4000);
      } else if (visibleAt >= 0 && state.firstPaintMs == null) {
        state.firstPaintMs = record.t;
      }
    }
    state.frames.push(record);
    frame += 1;
    if (frame < 120) handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return () => {
    observer.disconnect();
    cancelAnimationFrame(handle);
  };
};

/** One bench per fixture id and document; the gallery remounts by key. */
const benches = new Map<string, BenchState>();
const benchFor = (id: string): BenchState => {
  let found = benches.get(id);
  if (found == null) {
    found = build(id);
    benches.set(id, found);
  }
  return found;
};

export const ChatBench = ({ id }: { id: string }) => {
  const state = benchFor(id);
  const [committed, setCommitted] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const state = benchFor(id);
    (window as BenchWindow).__chatBench = state;
    let cancelled = false;
    // The loader: two callers, one promise (§3.2), then the commit.
    const started = performance.now();
    const first = state.session.load();
    const second = state.session.load();
    state.samePromise = first === second;
    first.then(
      () => {
        if (cancelled) return;
        state.loadMs = performance.now() - started;
        setCommitted(true);
      },
      (error: unknown) => {
        state.loadError = String(error);
      }
    );
    return () => {
      cancelled = true;
      // A later visit measures a fresh session.
      benches.delete(id);
      state.runtime.forget(id);
    };
  }, [id]);

  // The probe watches before ChatView's first commit.
  const [probing, setProbing] = useState(false);
  useEffect(() => {
    if (!committed || container.current == null) return;
    const state = benchFor(id);
    const stop = probe(container.current, state);
    state.mountedAt = performance.now();
    setProbing(true);
    return stop;
  }, [committed, id]);

  return (
    <div
      ref={container}
      className="bg-background fixed inset-0 z-50 flex flex-col"
      data-bench={id}
    >
      {committed && probing ? (
        <ChatView
          threadId={id}
          skin="session"
          runtime={state.runtime}
          workspaceRoot="/Users/me/code/bench"
          composer={COMPOSER}
        />
      ) : (
        <div data-slot="bench-loading" />
      )}
    </div>
  );
};
