/**
 * The transcript (spec 02 §10): the registry message scroller (stick to
 * bottom, prepend preservation, jump-to), day separators, run outcomes at
 * their anchor messages, the run tail (busy line / typing, then the latest
 * outcome), the "{n} new" marker, history paging and the bounded moving
 * window of mounted rows.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { ArrowDown } from "lucide-react";
// oxlint-disable-next-line no-restricted-imports -- The compiler cannot cache loop-built rows or the ref-backed paging closures; measured in scripts/perf-transcript.mjs.
import { memo, useCallback } from "react";
import {
  useEffect,
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
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "#renderer/ui/message-scroller";

import { useChatView } from "../kit/context";
import { DeliverableOfferRow } from "../kit/deliverable-offer";
import { appLineOf, userView, routeRowOf } from "../kit/message";
import {
  BusyLine,
  busyLabel,
  ErrorCard,
  FreeLaneChip,
  RunMarker,
  runningTools,
  Typing,
} from "../kit/status/status";
import { SuccessPitchRow } from "../kit/success-pitch";
import { outOfAbacusCredits, UpgradeTriggers } from "../kit/upgrade-triggers";
import { useHost, useThreadStore } from "../store/selectors";
import type { RunOutcomeRecord } from "../store/thread-store";
import { coalesceToolRuns, isToolOnly } from "./coalesce";
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

const ROWS =
  '[data-slot="message-scroller-item"], [data-tool], [data-slot="subagent-row"]';

export interface TranscriptProps {
  messages: UIMessage[];
  Message: ComponentType<{ message: UIMessage }>;
}

/**
 * Whether an outcome draws anything. A row that draws nothing must not be
 * mounted at all: it would still take its row gap (and, off screen, the
 * scroller's intrinsic-size estimate), a stray gap in the transcript.
 */
const outcomeShown = (
  outcome: RunOutcomeRecord,
  latest: boolean,
  skin: ReturnType<typeof useChatView>["skin"]
): boolean => {
  if (outcome.kind === "error") {
    // A crash or an interruption is stale once a retry has started (or any
    // later run exists).
    const code = outcome.error?.code;
    return (
      latest ||
      (code !== "agent_exit" &&
        code !== "agent_crashed" &&
        code !== "app_closed")
    );
  }
  // The bot skin renders no RunMarker (03-bots §24.2), only a free-lane
  // reply's label.
  return (
    skin !== "bot" || (outcome.kind === "success" && outcome.freeLane != null)
  );
};

const Outcome = ({
  outcome,
  latest,
}: {
  outcome: RunOutcomeRecord;
  latest: boolean;
}) => {
  const { skin } = useChatView();
  if (!outcomeShown(outcome, latest, skin)) return null;
  if (outcome.kind === "error")
    return <ErrorCard outcome={outcome} latest={latest} />;
  if (skin === "bot" && outcome.freeLane != null)
    return <FreeLaneChip provider={outcome.freeLane.provider} />;
  return <RunMarker outcome={outcome} latest={latest} />;
};

const OutcomeRow = ({
  outcome,
  latest,
}: {
  outcome: RunOutcomeRecord;
  latest: boolean;
}) => {
  const { skin } = useChatView();
  if (!outcomeShown(outcome, latest, skin)) return null;
  return (
    <MessageScrollerItem
      className="[content-visibility:visible]"
      // A run marker closes its turn (chat.css: 4 px under the actions row);
      // an error card is a block of its own and keeps the row gap.
      data-outcome={outcome.kind === "error" ? undefined : ""}
    >
      <Outcome outcome={outcome} latest={latest} />
    </MessageScrollerItem>
  );
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
  toolGap,
  turn,
}: {
  message: UIMessage;
  Message: TranscriptProps["Message"];
  start: number;
  end: number;
  more(id: string): void;
  earlier(id: string): void;
  fresh: boolean;
  toolGap: "same" | "different" | undefined;
  /** The sessions skin's rhythm key (chat.css); the bot skin has none. */
  turn: "user" | "assistant" | undefined;
}) {
  const ids = toolRows(message);
  return (
    <MessageScrollerItem
      // The window bounds mounted rows; real heights keep rows above the
      // reader from resizing as they scroll in.
      className="[content-visibility:visible]"
      messageId={message.id}
      data-fresh={fresh ? "" : undefined}
      data-tool-gap={toolGap}
      data-turn={turn}
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

/** Only tool results and blank text: the group draws the results itself. */
const drawsNothing = (message: UIMessage): boolean =>
  message.parts.every(
    (part) =>
      part.type === "tool-result" ||
      (part.type === "text" &&
        part.content.trim() === "" &&
        (part as { metadata?: { abacus?: { kind?: string } } }).metadata?.abacus
          ?.kind == null)
  );

const visibleMessages = (
  messages: UIMessage[],
  skin: ReturnType<typeof useChatView>["skin"],
  isMessageHidden: ReturnType<typeof useChatView>["slots"]["isMessageHidden"],
  active: boolean
) =>
  messages.filter((message, index) => {
    if (
      message.role === "user"
        ? userView(message).hidden &&
          appLineOf(message) == null &&
          routeRowOf(message) == null
        : message.parts.length === 0 ||
          (skin !== "bot" && drawsNothing(message))
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

const toolOnly = isToolOnly;

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

/** A wall the next run answered (a resume after paying): none of the person's messages came between. */
const wallAnswered = (
  outcome: RunOutcomeRecord,
  latest: boolean,
  messages: UIMessage[]
): boolean => {
  if (latest || !outOfAbacusCredits(outcome)) return false;
  const at = messages.findIndex(({ id }) => id === outcome.afterMessageId);
  return at >= 0 && messages[at + 1]?.role !== "user";
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

type HeldRow = { el: Element; top: number };

function holdRow(
  viewportRef: RefObject<HTMLDivElement | null>,
  held: RefObject<HeldRow | null>,
  change: () => void
) {
  const viewport = viewportRef.current;
  if (viewport != null) {
    const box = viewport.getBoundingClientRect();
    for (const el of viewport.querySelectorAll(ROWS)) {
      const rect = el.getBoundingClientRect();
      if (rect.top >= box.bottom) break;
      if (rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom) {
        held.current = { el, top: rect.top };
        viewport.style.overflowAnchor = "none";
        break;
      }
    }
  }
  change();
}

function useHold(
  viewportRef: RefObject<HTMLDivElement | null>,
  held: RefObject<HeldRow | null>
) {
  return useCallback(
    (change: () => void) => holdRow(viewportRef, held, change),
    [viewportRef, held]
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
  const shownMessages = visibleMessages(
    messages,
    skin,
    slots.isMessageHidden,
    active
  );
  // Sessions: consecutive tool steps, spread over several assistant
  // messages, read as one group in one row.
  const { visible, hostOf } =
    skin === "bot"
      ? { visible: shownMessages, hostOf: new Map<string, string>() }
      : (({ messages: merged, hostOf: hosts }) => ({
          visible: merged,
          hostOf: hosts,
        }))(coalesceToolRuns(shownMessages));
  const items = transcriptItems(visible, outcomes);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const placeholderHeight = (from: number, to: number) =>
    items
      .slice(from, to)
      .reduce(
        (height, item) =>
          height + (item.fixed + Math.min(item.units, 50)) * ROW_FALLBACK_PX,
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
  const jumpRow = jump == null ? null : (hostOf.get(jump) ?? jump);
  const jumpIndex =
    jumpRow == null
      ? -1
      : visible.findIndex((message) => message.id === jumpRow);
  if (jumpIndex >= 0 && (jumpIndex < window.start || jumpIndex >= window.end)) {
    setWindow(newestWindow(items.slice(0, jumpIndex + 1)));
  }
  useLayoutEffect(() => {
    if (!jump || handledJump.current === jump) return;
    const row = hostOf.get(jump) ?? jump;
    const index = visible.findIndex((message) => message.id === row);
    if (index < 0) return;
    const target = viewportRef.current?.querySelector<HTMLElement>(
      `[data-message-target="${CSS.escape(row)}"]`
    );
    if (!target) {
      // The row is there but carries no anchor: nothing to scroll to, and
      // the request must not linger for the next row that mounts.
      setJump(null);
      return;
    }
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
  }, [jump, visible, hostOf, window.start, window.end]);
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
  // Hold the end in the frame the content grows. The scroller follows a
  // frame later, so each streamed line would first paint under the composer.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (viewport == null || content == null) return;
    if (typeof ResizeObserver === "undefined") return;
    // At the end as of the last scroll or resize. A wheel can land in this
    // frame before its scroll event, so a smaller offset also lets go.
    let top = viewport.scrollTop;
    let atEnd = true;
    const settle = () => {
      top = viewport.scrollTop;
      atEnd = viewport.scrollHeight - top - viewport.clientHeight <= 8;
    };
    const observer = new ResizeObserver(() => {
      if (atEnd && viewport.scrollTop >= top - 1)
        viewport.scrollTop = viewport.scrollHeight;
      settle();
    });
    viewport.addEventListener("scroll", settle, { passive: true });
    observer.observe(viewport);
    // Its border box: the composer dock growing (a notice, a nudge) grows
    // only the content's bottom padding, which a content box never sees.
    observer.observe(content, { box: "border-box" });
    return () => {
      viewport.removeEventListener("scroll", settle);
      observer.disconnect();
    };
  }, []);
  const currentItems = useRef(items);
  useLayoutEffect(() => {
    currentItems.current = items;
  }, [items]);
  // A turn the reader sends takes them to the end, wherever they were.
  const { scrollToEnd } = useMessageScroller();
  const last = visible.at(-1);
  const sent = last?.role === "user" && !settled.has(last.id) ? last.id : null;
  useLayoutEffect(() => {
    if (sent == null) return;
    setWindow(newestWindow(currentItems.current));
    scrollToEnd();
  }, [sent, scrollToEnd]);
  // Paging the window keeps the first fully visible row where it was. Native
  // anchoring is off for that commit: it misses rows evicted across the top
  // edge, and would correct a second time on top of this.
  const held = useRef<HeldRow | null>(null);
  const hold = useHold(viewportRef, held);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const row = held.current;
    if (viewport == null || row == null) return;
    held.current = null;
    if (row.el.isConnected)
      viewport.scrollTop += row.el.getBoundingClientRect().top - row.top;
    viewport.style.overflowAnchor = "";
  }, [window]);
  const more = useCallback(
    (id: string) =>
      hold(() =>
        setWindow((current) => moreSteps(currentItems.current, current, id))
      ),
    [hold, setWindow]
  );
  const earlier = useCallback(
    (id: string) =>
      hold(() =>
        setWindow((current) => earlierSteps(currentItems.current, current, id))
      ),
    [hold, setWindow]
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

  const latest = active ? null : outcomes.at(-1)?.runId;
  const { byAnchor, orphans } = outcomesByAnchor(
    messages,
    visible,
    outcomes.filter(
      (outcome) => !wallAnswered(outcome, outcome.runId === latest, messages)
    )
  );
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
        toolGap={
          skin === "bot" ? toolGapBefore(shown[index - 1], message) : undefined
        }
        turn={
          skin === "bot"
            ? undefined
            : message.role === "user"
              ? "user"
              : "assistant"
        }
      />
    );
    for (const outcome of byAnchor.get(message.id) ?? [])
      rows.push(
        <OutcomeRow
          key={`outcome-${outcome.runId}`}
          outcome={outcome}
          latest={outcome.runId === latest}
        />
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
        // Where the browser anchors scrolling, the scroller's own prepend
        // restore would correct a second time.
        preserveScrollOnPrepend={!CSS.supports("overflow-anchor", "auto")}
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
            onActivate={() => hold(() => setWindow(showEarlier(items, window)))}
          />
        ) : null}
        <MessageScrollerContent
          ref={contentRef}
          aria-busy={active}
          className="mx-auto w-full max-w-(--content-max-w) min-w-0 gap-0 px-4 pt-6 pb-[calc(var(--composer-dock-h,0px)+var(--composer-dock-gap,16px)+var(--transcript-fade-size,80px))]"
        >
          {orphans.map((outcome) => (
            <OutcomeRow
              key={`outcome-${outcome.runId}`}
              outcome={outcome}
              latest={outcome.runId === latest}
            />
          ))}
          {rows}
          <RunTail messages={messages} />
          <DeliverableOfferRow messages={messages} active={active} />
          <SuccessPitchRow active={active} />
          <UpgradeTriggers
            messages={messages}
            outcome={active ? undefined : outcomes.at(-1)}
          />
        </MessageScrollerContent>{" "}
        {end < visible.length ? (
          <Placeholder
            rows={visible.length - end}
            height={placeholderHeight(end, visible.length)}
            label={t("chat.transcript.showLater")}
            onActivate={() => hold(() => setWindow(showLater(items, window)))}
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
