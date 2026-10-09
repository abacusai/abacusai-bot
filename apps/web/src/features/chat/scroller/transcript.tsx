/**
 * The transcript (spec 02 §10): the registry message scroller (stick to
 * bottom, anchored user turns, prepend preservation, jump-to), day
 * separators, run outcomes at their anchor messages, the run tail (busy
 * line / typing, then the latest outcome), the "{n} new" marker, history
 * paging and the bounded moving window of mounted rows.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { ArrowDown } from "lucide-react";
// oxlint-disable-next-line no-restricted-imports -- The compiler cannot cache loop-built rows or the ref-backed paging closures; measured in scripts/perf-transcript.mjs.
import { memo, useCallback } from "react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";
import { Marker, MarkerContent } from "#renderer/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "#renderer/ui/message-scroller";

import { useChatView } from "../kit/context";
import { userView } from "../kit/message";
import {
  BusyLine,
  busyLabel,
  ErrorCard,
  RunMarker,
  runningTools,
  Typing,
} from "../kit/status/status";
import { useHost, useThreadStore } from "../store/selectors";
import type { RunOutcomeRecord } from "../store/thread-store";
import { toolRows, ToolWindowProvider } from "./row-context";
import {
  dayKey,
  followWindow,
  messageTime,
  newestWindow,
  showEarlier,
  showLater,
  type WindowState,
  type RowItem,
  rangeOf,
  moreSteps,
  earlierSteps,
  ROW_FALLBACK_PX,
} from "./window";

export interface TranscriptProps {
  messages: UIMessage[];
  Message: ComponentType<{ message: UIMessage }>;
}

const Outcome = ({
  outcome,
  latest,
}: {
  outcome: RunOutcomeRecord;
  latest: boolean;
}) => {
  const { skin } = useChatView();
  if (outcome.kind === "error")
    return <ErrorCard outcome={outcome} latest={latest} />;
  // The bot skin renders no RunMarker (03-bots §24.2).
  return skin === "bot" ? null : <RunMarker outcome={outcome} />;
};

const RunTail = ({ messages }: { messages: UIMessage[] }) => {
  const { t } = useTranslation();
  const { session, skin, slots } = useChatView();
  const state = useThreadStore(session, (s) => s);
  const subagents = useHost(
    session,
    (s) => s.subagents.filter((h) => h.status === "running").length
  );
  const active = state.runs.active;
  if (active == null)
    return slots.runTail != null ? <>{slots.runTail}</> : null;
  const running = runningTools(messages);
  if (skin === "bot") {
    const caption =
      slots.typingCaption?.({
        status: state.activity.status,
        runningToolTitle: running[0] ?? null,
        runningTools: running.length,
      }) ??
      running[0] ??
      null;
    return <Typing caption={typeof caption === "string" ? caption : null} />;
  }
  return (
    <BusyLine
      label={busyLabel(t, { state, running, agents: subagents })}
      startedAt={active.startedAt}
    />
  );
};

const DaySeparator = ({ date }: { date: Date }) => {
  const { t, i18n } = useTranslation();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const label =
    dayKey(date) === dayKey(today)
      ? t("chat.day.today")
      : dayKey(date) === dayKey(yesterday)
        ? t("chat.day.yesterday")
        : date.toLocaleDateString(i18n.language, {
            weekday: "long",
            month: "short",
            day: "numeric",
          });
  return (
    <div className="flex justify-center py-1" data-slot="day-separator">
      <span className="rounded-full bg-[var(--chat-surface-2)] px-2 py-1 text-xs text-[var(--chat-status-muted)]">
        {label}
      </span>
    </div>
  );
};

/**
 * The first message that arrived while the reader was away from the end.
 * Previous values live in state and are compared during render (React's
 * "adjusting state when a prop changes"), never in an effect.
 */
const useNewMarker = (
  messages: UIMessage[]
): { id: string | null; count: number } => {
  const scrollable = useMessageScrollerScrollable();
  const visibility = useMessageScrollerVisibility();
  const [seen, setSeen] = useState(messages.length);
  const [marker, setMarker] = useState<{ id: string; from: number } | null>(
    null
  );
  if (seen !== messages.length) {
    const previous = seen;
    setSeen(messages.length);
    if (messages.length > previous) {
      if (messages.at(-1)?.role === "user") setMarker(null);
      else if (scrollable.end && marker == null) {
        const first = messages[previous];
        if (first != null && first.role !== "user")
          setMarker({ id: first.id, from: previous });
      }
    }
  }
  if (marker != null && visibility.visibleMessageIds.includes(marker.id))
    setMarker(null);
  return marker == null
    ? { id: null, count: 0 }
    : { id: marker.id, count: messages.length - marker.from };
};

const OlderRow = () => {
  const { t } = useTranslation();
  const { session } = useChatView();
  const older = useHost(session, (s) => s.older);
  const has = useHost(session, (s) => s.hasOlderMessages);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (element == null || !has || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void session.loadOlder();
      },
      {
        root: element.closest('[data-slot="message-scroller-viewport"]'),
        rootMargin: "640px 0px 0px",
      }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [has, session]);
  if (!has) return null;
  if (older === "error")
    return (
      <div
        className="text-muted-foreground flex items-center justify-center gap-2 py-2 text-xs"
        role="status"
      >
        {t("chat.transcript.olderFailed")}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void session.loadOlder()}
        >
          {t("chat.transcript.retry")}
        </Button>
      </div>
    );
  return (
    <div
      ref={sentinel}
      className="relative flex h-[17px] flex-col gap-2 py-2"
      aria-hidden
    >
      <div className="h-px" />
    </div>
  );
};

const Placeholder = ({
  rows,
  height,
  label,
  onActivate,
}: {
  rows: number;
  height: number;
  label: string;
  onActivate(): void;
}) => {
  const spacer = useRef<HTMLDivElement>(null);
  const away = useMessageScrollerScrollable().end;
  useEffect(() => {
    const el = spacer.current;
    if (!away || el == null || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onActivate();
        }
      },
      {
        root: el.closest('[data-slot="message-scroller-viewport"]'),
        rootMargin: "400px 0px",
        threshold: 0,
      }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onActivate, away]);
  return (
    <div
      ref={spacer}
      style={{ minHeight: height }}
      className="flex shrink-0 items-center justify-center"
    >
      <Button
        variant="ghost"
        size="sm"
        className="self-center"
        onClick={onActivate}
        data-slot="window-placeholder"
      >
        {label}
        <span className="sr-only">{` (${rows})`}</span>
      </Button>
    </div>
  );
};

// The compiler cannot cache JSX created inside the transcript loop.
const TranscriptMessage = memo(function TranscriptMessage({
  message,
  Message,
  start,
  end,
  more,
  earlier,
  fresh,
  virtual,
  height,
  toolGap,
}: {
  message: UIMessage;
  Message: TranscriptProps["Message"];
  start: number;
  end: number;
  more(id: string): void;
  earlier(id: string): void;
  fresh: boolean;
  virtual: boolean;
  height: number | undefined;
  toolGap: "same" | "different" | undefined;
}) {
  const ids = toolRows(message);
  return (
    <MessageScrollerItem
      // Resolve opening geometry before the route transition snapshots it.
      // Later renders can skip offscreen content, using measured row heights.
      className={virtual ? undefined : "[content-visibility:visible]"}
      style={
        height == null
          ? undefined
          : {
              containIntrinsicSize: `auto calc(${height}px - var(--transcript-row-gap, 0px))`,
            }
      }
      messageId={message.id}
      scrollAnchor={message.role === "user"}
      data-fresh={fresh ? "" : undefined}
      data-tool-gap={toolGap}
      data-tool-only={toolOnly(message) ? "" : undefined}
    >
      <ToolWindowProvider
        value={{
          ids,
          range: { start, end },
          more: () => more(message.id),
          earlier: () => earlier(message.id),
        }}
      >
        <Message message={message} />
      </ToolWindowProvider>
    </MessageScrollerItem>
  );
});

const visibleMessages = (
  messages: UIMessage[],
  skin: ReturnType<typeof useChatView>["skin"],
  isMessageHidden: ReturnType<typeof useChatView>["slots"]["isMessageHidden"],
  active: boolean
) =>
  messages.filter((message, index) => {
    if (
      message.role === "user"
        ? userView(message).hidden
        : message.parts.length === 0
    )
      return false;
    return (
      skin !== "bot" ||
      isMessageHidden?.(message, { messages, index, runActive: active }) !==
        true
    );
  });

const transcriptItems = (
  visible: UIMessage[],
  outcomes: readonly RunOutcomeRecord[]
): RowItem[] => {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.afterMessageId != null)
      counts.set(
        outcome.afterMessageId,
        (counts.get(outcome.afterMessageId) ?? 0) + 1
      );
  }
  return visible.map((message) => ({
    id: message.id,
    fixed: 1 + (counts.get(message.id) ?? 0),
    units: toolRows(message).length,
  }));
};

const toolOnly = (message: UIMessage | undefined): boolean =>
  message?.role === "assistant" &&
  message.parts.some((part) => part.type === "tool-call") &&
  message.parts.every(
    (part) =>
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      (part.type === "text" &&
        part.content.trim() === "" &&
        !(part as { metadata?: { abacus?: { kind?: string } } }).metadata
          ?.abacus?.kind)
  );

const toolGapBefore = (previous: UIMessage | undefined, message: UIMessage) => {
  if (!toolOnly(message) || !toolOnly(previous)) return undefined;
  const last = previous!.parts.findLast((part) => part.type === "tool-call");
  const first = message.parts.find((part) => part.type === "tool-call");
  return last?.type === "tool-call" &&
    first?.type === "tool-call" &&
    last.name === first.name
    ? ("same" as const)
    : ("different" as const);
};

const outcomesByAnchor = (
  messages: UIMessage[],
  visible: UIMessage[],
  outcomes: readonly RunOutcomeRecord[]
) => {
  const byAnchor = new Map<string, RunOutcomeRecord[]>();
  const orphans: RunOutcomeRecord[] = [];
  const ids = new Set(visible.map((m) => m.id));
  for (const outcome of outcomes) {
    let anchorId = outcome.afterMessageId;
    if (anchorId != null && !ids.has(anchorId)) {
      const index = messages.findIndex((message) => message.id === anchorId);
      if (index < 0) continue;
      anchorId =
        messages
          .slice(0, index)
          .reverse()
          .find((message) => ids.has(message.id))?.id ?? null;
    }
    if (anchorId != null)
      byAnchor.set(anchorId, [...(byAnchor.get(anchorId) ?? []), outcome]);
    else orphans.push(outcome);
  }
  return { byAnchor, orphans };
};

type ScrollAnchor = { el: Element; top: number; viewport: HTMLElement };

function preserveScroll(
  viewportRef: RefObject<HTMLDivElement | null>,
  observed: RefObject<ScrollAnchor | null>,
  anchor: RefObject<ScrollAnchor | null>,
  change: () => void
) {
  const viewport = viewportRef.current;
  if (viewport != null) {
    const box = viewport.getBoundingClientRect();
    const elements = Array.from(
      viewport.querySelectorAll(
        '[data-slot="message-scroller-item"], [data-tool], [data-slot="subagent-row"]'
      )
    );
    // Start near the last visible row. Scanning from the first mounted row
    // on each scroll forces layout of content-visibility's offscreen rows.
    const hint = observed.current?.el;
    let start = hint == null ? 0 : Math.max(0, elements.indexOf(hint));
    while (start > 0) {
      const rect = elements[start - 1]!.getBoundingClientRect();
      if (rect.height > 0 && rect.top < box.top) break;
      start -= 1;
    }
    for (let index = start; index < elements.length; index += 1) {
      const el = elements[index]!;
      const rect = el.getBoundingClientRect();
      // Later rows are below this viewport; don't force their skipped layout.
      if (rect.top >= box.bottom) break;
      if (rect.height <= 0 || rect.top < box.top || rect.bottom > box.bottom)
        continue;
      // Rows are in document order. Stop after the first fully visible row.
      anchor.current = { el, top: rect.top, viewport };
      break;
    }
  }
  change();
}

function usePreserveScroll(
  viewportRef: RefObject<HTMLDivElement | null>,
  observed: RefObject<ScrollAnchor | null>,
  anchor: RefObject<ScrollAnchor | null>
) {
  return useCallback(
    (change: () => void) =>
      preserveScroll(viewportRef, observed, anchor, change),
    [viewportRef, observed, anchor]
  );
}

export const Transcript = ({ messages, Message }: TranscriptProps) => {
  const { t } = useTranslation();
  const { session, slots, skin } = useChatView();
  const active = useThreadStore(session, (s) => s.runs.active != null);
  const outcomes = useThreadStore(session, (s) => s.runs.outcomes);
  const fresh = useThreadStore(session, (s) => s.fresh);
  // The entry motion (`data-fresh`, chat.css) is for a message this
  // transcript sees arrive. Rows already here when it mounted (a route
  // entering a thread whose last reply came in live earlier) are history to
  // it: the route's view transition brings them in as one snapshot, and no
  // row rises a second time underneath.
  const [settled] = useState(
    () => new Set(messages.map((message) => message.id))
  );
  const visible = visibleMessages(
    messages,
    skin,
    slots.isMessageHidden,
    active
  );
  const items = transcriptItems(visible, outcomes);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(
    new Map()
  );
  const placeholderHeight = (from: number, to: number) =>
    items
      .slice(from, to)
      .reduce(
        (height, item) =>
          height +
          (measured.get(item.id) ??
            (item.fixed + Math.min(item.units, 50)) * ROW_FALLBACK_PX),
        0
      );
  const [window, setWindow] = useState<WindowState>(() => newestWindow(items));
  const [selectionWindow, setSelectionWindow] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const away = useMessageScrollerScrollable().end;
  useEffect(() => {
    if (!away && selectionWindow == null) session.retain();
  }, [away, messages, session, selectionWindow]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState<string | null>(null);
  const handledJump = useRef<string | null>(null);
  const highlight = useRef<{
    target: HTMLElement;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  useEffect(
    () => () => {
      if (highlight.current) {
        globalThis.clearTimeout(highlight.current.timer);
        delete highlight.current.target.dataset.highlighted;
      }
    },
    []
  );
  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (
        event as CustomEvent<{ messageId: string; threadId: string }>
      ).detail;
      if (detail.threadId !== session.threadId) return;
      const id = detail.messageId;
      if (session.hostStore.state.messages.some((message) => message.id === id))
        setJump(id);
      else
        void (async () => {
          while (session.hostStore.state.hasOlderMessages) {
            const cursor = session.hostStore.state.olderCursor;
            await session.loadOlder();
            if (
              session.hostStore.state.messages.some(
                (message) => message.id === id
              )
            ) {
              setJump(id);
              return;
            }
            if (cursor === session.hostStore.state.olderCursor) return;
          }
        })();
    };
    document.addEventListener("chat:jump-to-message", onJump);
    return () => document.removeEventListener("chat:jump-to-message", onJump);
  }, [session]);
  const jumpIndex =
    jump == null ? -1 : visible.findIndex((message) => message.id === jump);
  if (jumpIndex >= 0 && (jumpIndex < window.start || jumpIndex >= window.end)) {
    setWindow(newestWindow(items.slice(0, jumpIndex + 1)));
  }
  useLayoutEffect(() => {
    if (!jump || handledJump.current === jump) return;
    const index = visible.findIndex((message) => message.id === jump);
    if (index < 0) return;
    const target = viewportRef.current?.querySelector<HTMLElement>(
      `[data-message-target="${CSS.escape(jump)}"]`
    );
    if (!target) return;
    handledJump.current = jump;
    if (highlight.current) {
      globalThis.clearTimeout(highlight.current.timer);
      delete highlight.current.target.dataset.highlighted;
    }
    target.scrollIntoView({ block: "center", behavior: "instant" });
    target.dataset.highlighted = "";
    const timer = globalThis.setTimeout(() => {
      delete target.dataset.highlighted;
      highlight.current = null;
      handledJump.current = null;
      setJump(null);
    }, 1200);
    highlight.current = { target, timer };
  }, [jump, visible, window.start, window.end]);
  const opened = useRef(false);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport == null || opened.current) return;
    // Force the opening geometry in the commit, before a route transition
    // snapshots it. A second read resolves content-visibility estimates.
    viewport.scrollTop = viewport.scrollHeight;
    viewport.scrollTop = viewport.scrollHeight;
    opened.current = true;
  });
  const anchor = useRef<ScrollAnchor | null>(null);
  const observed = useRef<ScrollAnchor | null>(null);
  // Stable callbacks keep each row's tool context unchanged while another
  // message streams. The helper reads current geometry only when invoked.
  const preserve = usePreserveScroll(viewportRef, observed, anchor);
  const onPrepend = useEffectEvent(() => preserve(() => {}));
  useEffect(() => session.onPrepend(onPrepend), [session]);
  const lastMessages = useRef(messages);
  const messageIds = messages.map((item) => item.id).join("\0");
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ids = new Set(messageIds.split("\0"));
    const observer = new ResizeObserver((entries) => {
      setMeasured((previous) => {
        const next = new Map([...previous].filter(([id]) => ids.has(id)));
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const height =
            entry.borderBoxSize?.[0]?.blockSize ??
            el.getBoundingClientRect().height;
          if (height > 0) next.set(el.dataset.messageId!, height);
        }
        return next.size !== previous.size ||
          [...next].some(([id, height]) => previous.get(id) !== height)
          ? next
          : previous;
      });
    });
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-slot="message-scroller-item"][data-message-id]'
    ))
      observer.observe(el);
    return () => observer.disconnect();
  }, [messageIds, window.start, window.end]);
  useLayoutEffect(() => {
    const saved =
      anchor.current ??
      (lastMessages.current !== messages ? observed.current : null);
    lastMessages.current = messages;
    anchor.current = null;
    if (saved == null) return;
    const restore = () => {
      if (saved.el.isConnected)
        saved.viewport.scrollTop +=
          saved.el.getBoundingClientRect().top - saved.top;
    };
    // Registry's mutation observer runs after the commit. Correct after it,
    // before the browser paints, and again after intrinsic sizes resolve.
    queueMicrotask(restore);
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(restore);
    });
  });
  const currentItems = useRef(items);
  useLayoutEffect(() => {
    currentItems.current = items;
  }, [items]);
  const more = useCallback(
    (id: string) =>
      preserve(() =>
        setWindow((current) => moreSteps(currentItems.current, current, id))
      ),
    [preserve, setWindow]
  );
  const earlier = useCallback(
    (id: string) =>
      preserve(() =>
        setWindow((current) => earlierSteps(currentItems.current, current, id))
      ),
    [preserve, setWindow]
  );
  const signature = items
    .map((item) => `${item.id}:${item.fixed}:${item.units}`)
    .join("|");
  const [previous, setPrevious] = useState({
    signature,
    total: visible.length,
    first: visible[0]?.id,
  });
  const marker = useNewMarker(visible);

  // Follow list changes (a page mounts above; the end follows new rows).
  if (
    previous.signature !== signature ||
    previous.total !== visible.length ||
    previous.first !== visible[0]?.id
  ) {
    const oldFirst = previous.first;
    const prepended =
      oldFirst == null
        ? 0
        : Math.max(
            0,
            visible.findIndex((m) => m.id === oldFirst)
          );
    const next = followWindow(window, previous.total, items, prepended, !away);
    setPrevious({ signature, total: visible.length, first: visible[0]?.id });
    if (
      next.start !== window.start ||
      next.end !== window.end ||
      JSON.stringify(next.ranges) !== JSON.stringify(window.ranges)
    )
      setWindow(next);
  }

  const { byAnchor, orphans } = outcomesByAnchor(messages, visible, outcomes);
  const latest = active ? null : outcomes.at(-1)?.runId;
  // Keep the mounted selection window until selection is released. Moving
  // paging boundaries can then load rows without destroying the native range.

  const dragging = useRef(false);
  useEffect(() => {
    const release = () => {
      dragging.current = false;
      if (document.getSelection()?.isCollapsed !== false)
        setSelectionWindow(null);
    };
    const changed = () => {
      if (!dragging.current && document.getSelection()?.isCollapsed !== false)
        setSelectionWindow(null);
    };
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    document.addEventListener("selectionchange", changed);
    return () => {
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.removeEventListener("selectionchange", changed);
    };
  }, []);
  const start = Math.min(window.start, selectionWindow?.start ?? window.start);
  const end = Math.max(window.end, selectionWindow?.end ?? window.end);
  const shown = visible.slice(start, end);
  let lastDay: string | null = null;
  for (let index = 0; index < start; index += 1) {
    const key = dayKey(messageTime(visible[index]!));
    if (key != null) lastDay = key;
  }
  const rows: ReactNode[] = [];
  for (const [index, message] of shown.entries()) {
    const time = messageTime(message);
    const key = dayKey(time);
    if (key != null && key !== lastDay && time != null) {
      rows.push(<DaySeparator key={`day-${message.id}`} date={time} />);
      lastDay = key;
    }
    if (marker.id === message.id)
      rows.push(
        <Marker
          key="new-marker"
          className="py-3"
          variant="separator"
          data-slot="new-marker"
        >
          <MarkerContent>
            {t("chat.transcript.new", { count: marker.count })}
          </MarkerContent>
        </Marker>
      );
    const range = rangeOf(itemsById.get(message.id)!, window.ranges);
    rows.push(
      <TranscriptMessage
        key={message.id}
        message={message}
        Message={Message}
        start={range.start}
        end={range.end}
        more={more}
        earlier={earlier}
        fresh={fresh[message.id] === true && !settled.has(message.id)}
        virtual={measured.size > 0 && selectionWindow == null}
        height={measured.get(message.id)}
        toolGap={toolGapBefore(shown[index - 1], message)}
      />
    );
    for (const outcome of byAnchor.get(message.id) ?? [])
      rows.push(
        <MessageScrollerItem key={`outcome-${outcome.runId}`}>
          <Outcome outcome={outcome} latest={outcome.runId === latest} />
        </MessageScrollerItem>
      );
  }

  return (
    <MessageScroller>
      <MessageScrollerViewport
        ref={viewportRef}
        className="scroll-fade-y"
        data-transcript-fade
        data-continuity-scroll="chat-transcript"
        // The header's scroll-linked morph into the title bar reads this
        // viewport's named timeline (bots.css).
        data-identity-timeline={slots.header != null ? "" : undefined}
        preserveScrollOnPrepend
        style={{
          overflowAnchor: "none",
        }}
        aria-label={t("chat.transcript.label")}
        onPointerDownCapture={(event) => {
          if (
            event.button === 0 &&
            (event.target as HTMLElement).closest("[data-message-text]")
          ) {
            dragging.current = true;
            setSelectionWindow({ start, end });
          }
        }}
        onKeyDownCapture={(event) => {
          if (
            (event.target as HTMLElement).closest("[data-message-text]") &&
            (event.shiftKey || event.metaKey || event.ctrlKey)
          )
            setSelectionWindow({ start, end });
        }}
        onScroll={() => {
          preserve(() => {});
          observed.current = anchor.current;
          anchor.current = null;
        }}
      >
        {slots.header && (
          <div className="[container-type:inline-size] px-4 pt-3">
            {slots.header}
          </div>
        )}
        {start === 0 ? <OlderRow /> : null}
        {start > 0 ? (
          <Placeholder
            rows={start}
            height={placeholderHeight(0, start)}
            label={t("chat.transcript.showEarlier")}
            onActivate={() =>
              preserve(() => setWindow(showEarlier(items, window)))
            }
          />
        ) : null}
        <MessageScrollerContent
          aria-busy={active}
          className="mx-auto w-full max-w-(--content-max-w) min-w-0 gap-0 px-4 pt-6 pb-[calc(var(--composer-dock-h,0px)+var(--composer-dock-gap,16px)+var(--transcript-fade-size,80px))]"
        >
          {orphans.map((outcome) => (
            <MessageScrollerItem key={`outcome-${outcome.runId}`}>
              <Outcome outcome={outcome} latest={outcome.runId === latest} />
            </MessageScrollerItem>
          ))}
          {rows}
          <RunTail messages={messages} />
        </MessageScrollerContent>{" "}
        {end < visible.length ? (
          <Placeholder
            rows={visible.length - end}
            height={placeholderHeight(end, visible.length)}
            label={t("chat.transcript.showLater")}
            onActivate={() =>
              preserve(() => setWindow(showLater(items, window)))
            }
          />
        ) : null}
      </MessageScrollerViewport>
      <MessageScrollerButton
        direction="end"
        className="bg-popover text-popover-foreground phone:h-10 phone:min-w-10 phone:rounded-full phone:bg-popover/85 phone:backdrop-blur-lg border opacity-100 shadow-lg data-[direction=end]:bottom-[calc(var(--composer-dock-h,0px)+var(--composer-dock-gap,16px)+var(--transcript-fade-size,80px))]"
        aria-label={
          marker.count > 0
            ? t("chat.transcript.jumpNew", { count: marker.count })
            : t("chat.transcript.jump")
        }
        onClick={() => setWindow(newestWindow(items))}
      >
        <ArrowDown aria-hidden />
        {marker.count > 0 ? (
          <span className="text-xs">{marker.count}</span>
        ) : null}
      </MessageScrollerButton>
    </MessageScroller>
  );
};
