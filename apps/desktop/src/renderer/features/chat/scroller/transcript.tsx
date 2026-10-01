/**
 * The transcript (spec 02 §10): the registry message scroller (stick to
 * bottom, anchored user turns, prepend preservation, jump-to), day
 * separators, run outcomes at their anchor messages, the run tail (busy
 * line / typing, then the latest outcome), the "{n} new" marker, history
 * paging and the bounded moving window of mounted rows.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { ArrowDown } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
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
import { Skeleton } from "#renderer/ui/skeleton";

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

/** The screenshot run's build (dev fixture tables). */
const VISUAL_BUILD = import.meta.env.VITE_NEXT_DB_FIXTURES === "1";

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
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting))
        void session.loadOlder();
    });
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
      {older === "loading" ? (
        <Skeleton className="absolute h-10 w-2/3" />
      ) : (
        <div className="h-px" />
      )}
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
  const control = useRef<HTMLButtonElement>(null);
  const away = useMessageScrollerScrollable().end;
  useEffect(() => {
    const el = control.current;
    if (!away || el == null || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some(
            (entry) => entry.isIntersecting && entry.intersectionRatio === 1
          )
        ) {
          observer.disconnect();
          onActivate();
        }
      },
      {
        root: el.closest('[data-slot="message-scroller-viewport"]'),
        threshold: 1,
      }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onActivate, away]);
  return (
    <div
      style={{ minHeight: height }}
      className="flex shrink-0 items-center justify-center"
    >
      <Button
        ref={control}
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

const TranscriptMessage = ({
  message,
  Message,
  start,
  end,
  more,
  earlier,
  fresh,
  toolIds,
}: {
  message: UIMessage;
  Message: TranscriptProps["Message"];
  start: number;
  end: number;
  more(id: string): void;
  earlier(id: string): void;
  fresh: boolean;
  toolIds: string[];
}) => (
  <MessageScrollerItem
    className="[content-visibility:visible]"
    messageId={message.id}
    scrollAnchor={message.role === "user"}
    data-fresh={fresh ? "" : undefined}
  >
    <ToolWindowProvider
      value={{
        ids: toolIds,
        range: { start, end },
        more: () => more(message.id),
        earlier: () => earlier(message.id),
      }}
    >
      <Message message={message} />
    </ToolWindowProvider>
  </MessageScrollerItem>
);

export const Transcript = ({ messages, Message }: TranscriptProps) => {
  const { t } = useTranslation();
  const { session, slots, skin } = useChatView();
  const active = useThreadStore(session, (s) => s.runs.active != null);
  const outcomes = useThreadStore(session, (s) => s.runs.outcomes);
  const fresh = useThreadStore(session, (s) => s.fresh);
  const visible = messages.filter((message, index) => {
    if (
      message.role === "user"
        ? userView(message).hidden
        : message.parts.length === 0
    )
      return false;
    return (
      skin !== "bot" ||
      slots.isMessageHidden?.(message, {
        messages,
        index,
        runActive: active,
      }) !== true
    );
  });
  const outcomeCounts = new Map<string | null, number>();
  for (const outcome of outcomes)
    outcomeCounts.set(
      outcome.afterMessageId,
      (outcomeCounts.get(outcome.afterMessageId) ?? 0) + 1
    );
  const toolIds = new Map(
    visible.map((message) => [message.id, toolRows(message)])
  );
  const items: RowItem[] = visible.map((message) => ({
    id: message.id,
    fixed: 1 + (outcomeCounts.get(message.id) ?? 0),
    units: toolIds.get(message.id)!.length,
  }));
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
  const away = useMessageScrollerScrollable().end;
  useEffect(() => {
    if (!away) session.retain();
  }, [away, messages, session]);
  const viewportRef = useRef<HTMLDivElement>(null);
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
  const anchor = useRef<{
    el: Element;
    top: number;
    viewport: HTMLElement;
  } | null>(null);
  const preserve = (change: () => void) => {
    const viewport = viewportRef.current;
    if (viewport != null) {
      const box = viewport.getBoundingClientRect();
      // Rows follow document order, including nested tools. Stop at the
      // first fully visible row instead of measuring and sorting every row.
      for (const el of viewport.querySelectorAll(
        '[data-slot="message-scroller-item"], [data-tool], [data-slot="subagent-row"]'
      )) {
        const rect = el.getBoundingClientRect();
        if (
          rect.height > 0 &&
          rect.top >= box.top &&
          rect.bottom <= box.bottom
        ) {
          anchor.current = { el, top: rect.top, viewport };
          break;
        }
      }
    }
    change();
  };
  const onPrepend = useEffectEvent(() => preserve(() => {}));
  useEffect(() => session.onPrepend(onPrepend), [session]);
  const observed = useRef<typeof anchor.current>(null);
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
          if (height > 0) next.set(el.dataset.messageId!, height + 12);
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
  const more = (id: string) =>
    preserve(() =>
      setWindow((current) => moreSteps(currentItems.current, current, id))
    );
  const earlier = (id: string) =>
    preserve(() =>
      setWindow((current) => earlierSteps(currentItems.current, current, id))
    );
  const signature = items
    .map((item) => `${item.id}:${item.fixed}:${item.units}`)
    .join("|");
  const [previous, setPrevious] = useState({
    signature,
    total: visible.length,
    first: visible[0]?.id,
  });
  const marker = useNewMarker(messages);

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
  const latest = active ? null : outcomes.at(-1)?.runId;
  const shown = visible.slice(window.start, window.end);
  let lastDay: string | null = null;
  for (let index = 0; index < window.start; index += 1) {
    const key = dayKey(messageTime(visible[index]!));
    if (key != null) lastDay = key;
  }
  const rows: ReactNode[] = [];
  for (const message of shown) {
    const time = messageTime(message);
    const key = dayKey(time);
    if (key != null && key !== lastDay && time != null) {
      rows.push(<DaySeparator key={`day-${message.id}`} date={time} />);
      lastDay = key;
    }
    if (marker.id === message.id)
      rows.push(
        <Marker key="new-marker" variant="separator" data-slot="new-marker">
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
        fresh={fresh[message.id] === true}
        toolIds={toolIds.get(message.id)!}
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
      {/* No `scroll-fade-t` yet, and in the visual (fixture) build no
          scroll fade at all: the scroll-driven fade animations never finish,
          and the screenshot run's settle step waits for every finite
          animation (change request on `lib/dev/settle.ts`). */}
      <MessageScrollerViewport
        ref={viewportRef}
        data-continuity-scroll="chat-transcript"
        preserveScrollOnPrepend
        style={{ overflowAnchor: "none" }}
        aria-label={t("chat.transcript.label")}
        onScroll={() => {
          preserve(() => {});
          observed.current = anchor.current;
          anchor.current = null;
        }}
        {...(VISUAL_BUILD
          ? { style: { animation: "none", maskImage: "none" } }
          : {})}
      >
        {slots.header}
        {window.start === 0 ? <OlderRow /> : null}
        {window.start > 0 ? (
          <Placeholder
            rows={window.start}
            height={placeholderHeight(0, window.start)}
            label={t("chat.transcript.showEarlier")}
            onActivate={() =>
              preserve(() => setWindow(showEarlier(items, window)))
            }
          />
        ) : null}
        <MessageScrollerContent
          aria-busy={active}
          className="mx-auto w-full max-w-[720px] min-w-0 gap-3 px-4 pt-6 pb-4"
        >
          {orphans.map((outcome) => (
            <MessageScrollerItem key={`outcome-${outcome.runId}`}>
              <Outcome outcome={outcome} latest={outcome.runId === latest} />
            </MessageScrollerItem>
          ))}
          {rows}
          <RunTail messages={messages} />
        </MessageScrollerContent>{" "}
        {window.end < visible.length ? (
          <Placeholder
            rows={visible.length - window.end}
            height={placeholderHeight(window.end, visible.length)}
            label={t("chat.transcript.showLater")}
            onActivate={() =>
              preserve(() => setWindow(showLater(items, window)))
            }
          />
        ) : null}
      </MessageScrollerViewport>
      <MessageScrollerButton
        direction="end"
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
