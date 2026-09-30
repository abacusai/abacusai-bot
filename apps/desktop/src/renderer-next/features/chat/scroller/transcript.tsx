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
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#next/ui/button";
import { Marker, MarkerContent } from "#next/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "#next/ui/message-scroller";
import { Skeleton } from "#next/ui/skeleton";

import { useChatView } from "../kit/context";
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
import {
  dayKey,
  followWindow,
  messageTime,
  newestWindow,
  showEarlier,
  showLater,
  type RowWindow,
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
      <span className="text-muted-foreground rounded-full bg-[var(--chat-surface-2)] px-2 py-1 text-xs">
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
    <div ref={sentinel} className="flex flex-col gap-2 py-2" aria-hidden>
      {older === "loading" ? (
        <Skeleton className="h-10 w-2/3" />
      ) : (
        <div className="h-px" />
      )}
    </div>
  );
};

const Placeholder = ({
  rows,
  label,
  onActivate,
}: {
  rows: number;
  label: string;
  onActivate(): void;
}) => (
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
);

export const Transcript = ({ messages, Message }: TranscriptProps) => {
  const { t } = useTranslation();
  const { session, slots } = useChatView();
  const active = useThreadStore(session, (s) => s.runs.active != null);
  const outcomes = useThreadStore(session, (s) => s.runs.outcomes);
  const fresh = useThreadStore(session, (s) => s.fresh);
  const [window, setWindow] = useState<RowWindow>(() =>
    newestWindow(messages.length)
  );
  const [previous, setPrevious] = useState({
    total: messages.length,
    first: messages[0]?.id,
  });
  const marker = useNewMarker(messages);

  // Follow list changes (a page mounts above; the end follows new rows).
  if (
    previous.total !== messages.length ||
    previous.first !== messages[0]?.id
  ) {
    const oldFirst = previous.first;
    const prepended =
      oldFirst == null
        ? 0
        : Math.max(
            0,
            messages.findIndex((m) => m.id === oldFirst)
          );
    const next = followWindow(
      window,
      previous.total,
      messages.length,
      prepended
    );
    setPrevious({ total: messages.length, first: messages[0]?.id });
    if (next.start !== window.start || next.end !== window.end) setWindow(next);
  }

  const byAnchor = new Map<string, RunOutcomeRecord[]>();
  const orphans: RunOutcomeRecord[] = [];
  const ids = new Set(messages.map((m) => m.id));
  for (const outcome of outcomes) {
    if (outcome.afterMessageId != null && ids.has(outcome.afterMessageId))
      byAnchor.set(outcome.afterMessageId, [
        ...(byAnchor.get(outcome.afterMessageId) ?? []),
        outcome,
      ]);
    else if (outcome.afterMessageId == null) orphans.push(outcome);
  }
  const latest = active ? null : outcomes.at(-1)?.runId;
  const shown = messages.slice(window.start, window.end);
  let lastDay: string | null = null;
  for (let index = 0; index < window.start; index += 1) {
    const key = dayKey(messageTime(messages[index]!));
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
    rows.push(
      <MessageScrollerItem
        key={message.id}
        messageId={message.id}
        scrollAnchor={message.role === "user"}
        data-fresh={fresh[message.id] ? "" : undefined}
      >
        <Message message={message} />
      </MessageScrollerItem>
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
      {/* No `scroll-fade-t` yet: its scroll-driven animation never finishes,
          and the screenshot run's settle step waits for every finite one
          (change request on `lib/dev/settle.ts`). */}
      <MessageScrollerViewport aria-label={t("chat.transcript.label")}>
        <MessageScrollerContent
          aria-busy={active}
          className="mx-auto w-full max-w-[720px] gap-3 px-4 pt-6 pb-4"
        >
          {slots.header}
          {window.start === 0 ? <OlderRow /> : null}
          {window.start > 0 ? (
            <Placeholder
              rows={window.start}
              label={t("chat.transcript.showEarlier")}
              onActivate={() => setWindow(showEarlier(window))}
            />
          ) : null}
          {orphans.map((outcome) => (
            <MessageScrollerItem key={`outcome-${outcome.runId}`}>
              <Outcome outcome={outcome} latest={outcome.runId === latest} />
            </MessageScrollerItem>
          ))}
          {rows}
          {window.end < messages.length ? (
            <Placeholder
              rows={messages.length - window.end}
              label={t("chat.transcript.showLater")}
              onActivate={() => setWindow(showLater(window, messages.length))}
            />
          ) : null}
          <RunTail messages={messages} />
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton
        direction="end"
        aria-label={
          marker.count > 0
            ? t("chat.transcript.jumpNew", { count: marker.count })
            : t("chat.transcript.jump")
        }
        onClick={() => setWindow(newestWindow(messages.length))}
      >
        <ArrowDown aria-hidden />
        {marker.count > 0 ? (
          <span className="text-xs">{marker.count}</span>
        ) : null}
      </MessageScrollerButton>
    </MessageScroller>
  );
};
