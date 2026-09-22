import { Bot, ChevronRight } from "lucide-react";
import { useMemo, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { SubtaskSummary } from "../../conversation";
import { Markdown } from "../common/markdown";
import { Button } from "../ui";
import { UserMessageBubble } from "./agent-message";
import { wantsModelSwitch } from "./agent-message";
import { BUBBLE_MAX_WIDTH } from "./bubble-width";
import { turnDeliverables } from "./deliverables";
import { DeliverablesPill } from "./deliverables-pill";
import { PremiumUpgradeCard, wantsUpgradeCard } from "./premium-upgrade-card";
import type { AgentRenderItem, ChatRenderItem } from "./render-utils";
import { ShimmerText } from "./shimmer-text";
import {
  formatDuration,
  KIND_LABEL_KEYS,
  LiveTimer,
  statusIcon,
  SubtaskReport,
} from "./subtask-card";

/**
 * A bot's chat as a message thread, not a work log: a bot is not supervised, so
 * the tool groups are dropped and each run of prose is its own bubble, which is
 * exactly the bubbles a person would have sent. Notifications stay as quieter
 * bubbles (a bot that silently did nothing looks stuck), and each turn's
 * deliverables follow its bubbles as a files card, since hiding the tool log
 * would hide the doc a bot wrote with it.
 */

/**
 * Fifteen minutes is the gap that means you left and came back; stamping the
 * middle of a conversation breaks it into pieces that were never separate.
 */
const QUIET_GAP_MS = 15 * 60 * 1000;

/** "Yesterday 1:22 PM" — the day only when it is not today. */
const stampLabel = (at: number, now: number): string => {
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const dayBefore = midnight.getTime() - 24 * 60 * 60 * 1000;

  if (at >= midnight.getTime()) return time;
  if (at >= dayBefore) return `Yesterday ${time}`;
  // A week back stops being "last Tuesday" and starts being a date.
  const withinWeek = at >= midnight.getTime() - 6 * 24 * 60 * 60 * 1000;
  const day = when.toLocaleDateString(
    undefined,
    withinWeek ? { weekday: "long" } : { month: "short", day: "numeric" }
  );
  return `${day} ${time}`;
};

/**
 * Text a bot actually said, plus a sub-agent it handed work to: that is minutes
 * of work the thread would otherwise show as three dots.
 */
const spokenItems = (items: AgentRenderItem[]): AgentRenderItem[] =>
  items.filter(
    (item) =>
      (item.kind === "text" && item.content.trim().length > 0) ||
      item.kind === "notification" ||
      item.kind === "subtask"
  );

const BotBubble = ({
  children,
  tone = "said",
}: {
  children: ReactNode;
  /** A notification is the bot reporting a condition, not speaking. */
  tone?: "said" | "notice";
}): JSX.Element => (
  <div
    className={`${BUBBLE_MAX_WIDTH} rounded-2xl px-3.5 py-2 text-sm leading-[1.5] [overflow-wrap:anywhere] ${
      tone === "notice"
        ? "bg-muted/60 text-muted-foreground"
        : "bg-sidebar text-foreground"
    }`}
  >
    {children}
  </div>
);

/**
 * A sub-agent's work in the thread as it happens: a header says who is working
 * and for how long, its words stream as bubbles under its name, and when it
 * finishes the header settles into a record that opens the full transcript.
 */
const BotSubtaskThread = ({
  summary,
  onOpen,
}: {
  summary: SubtaskSummary;
  onOpen?: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const running = summary.status === "running";
  const { icon, className } = statusIcon(summary.status);
  const StatusIcon = icon;
  const kindLabel =
    summary.kind != null && KIND_LABEL_KEYS[summary.kind] != null
      ? t(KIND_LABEL_KEYS[summary.kind]!)
      : t("workspace.subtask.agent");
  const detail: string[] = [];
  if (summary.status === "interrupted")
    detail.push(t("workspace.subtask.didNotFinish"));
  if (summary.toolCount > 0)
    detail.push(t("workspace.subtask.toolCount", { count: summary.toolCount }));
  if (running && summary.lastToolLabel != null)
    detail.push(summary.lastToolLabel);
  const duration = formatDuration(summary.startTime, summary.endTime);
  if (!running && duration != null) detail.push(duration);
  const header = [kindLabel, ...detail].join(" · ");
  // A finished run's last words are its report, rendered below as its own bubble.
  const narration = running
    ? summary.narration
    : summary.narration.slice(0, -1);

  const bubble = (content: ReactNode, key: string): JSX.Element => (
    <div key={key} className={`${BUBBLE_MAX_WIDTH} flex items-start gap-2`}>
      <Bot className="text-muted-foreground mt-2 size-3.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-muted-foreground mb-0.5 text-[10px] tracking-wide uppercase">
          {kindLabel}
        </div>
        <div className="border-border/70 bg-background/60 text-foreground rounded-2xl rounded-tl-md border px-3.5 py-2 text-sm leading-[1.5] [overflow-wrap:anywhere]">
          {content}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="flex w-full flex-col items-start gap-1"
      data-id={`bot-message-subtask-${summary.id}`}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={onOpen}
        title={t("workspace.subtask.viewTranscript")}
        className="text-muted-foreground h-auto justify-start gap-2 px-2 py-1 text-left text-xs font-normal"
        data-id={`bot-message-subtask-header-${summary.id}`}
      >
        <StatusIcon
          className={`size-3 shrink-0 ${running ? className : "text-muted-foreground"}`}
        />
        <span className="min-w-0 truncate">
          {running ? <ShimmerText>{header}</ShimmerText> : header}
        </span>
        {running && summary.startTime != null && (
          <LiveTimer startTime={summary.startTime} />
        )}
        <ChevronRight className="size-3 shrink-0" />
      </Button>
      {narration.map((entry, index) =>
        bubble(<Markdown content={entry} />, `say-${index}`)
      )}
      {!running &&
        summary.textFinal != null &&
        bubble(<SubtaskReport summary={summary} />, "report")}
    </div>
  );
};

/**
 * A bot's thread hides its tool calls, so without this a bot reading half your
 * home directory looks exactly like one that has stopped replying.
 */
const WorkingBubble = (): JSX.Element => (
  <div className="flex items-start" data-id="bot-message-working">
    <div className="bg-sidebar flex items-center gap-1 rounded-2xl px-3.5 py-3">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  </div>
);

export const BotMessageList = ({
  chatItems,
  times,
  isWorking = false,
  onOpenSubtask,
  onSwitchModel,
}: {
  chatItems: ChatRenderItem[];
  /** When each segment first arrived, by segment id. See persistence.ts. */
  times?: Map<string, number>;
  isWorking?: boolean;
  onOpenSubtask?: (subtaskId: string) => void;
  /** Point the user at the model picker — a pinned model that keeps failing. */
  onSwitchModel?: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const rows = useMemo(
    () =>
      chatItems
        // Rows are filtered, so a source index rides along for lookups.
        .map((item, sourceIndex) =>
          item.kind === "user"
            ? { ...item, sourceIndex }
            : {
                ...item,
                items: spokenItems(item.items),
                deliverables: turnDeliverables(item.items),
                sourceIndex,
              }
        )
        // A turn that only called tools said nothing, and an empty bubble reads
        // as a failed message; unless it made something, a file card is news.
        .filter(
          (item) =>
            item.kind === "user" ||
            item.items.length > 0 ||
            item.deliverables.length > 0
        ),
    [chatItems]
  );

  // Read once per render: a clock moving between two rows could date them apart.
  const now = Date.now();
  const timeOf = (item: (typeof rows)[number]): number | undefined =>
    times?.get(item.kind === "user" ? item.id : (item.items[0]?.id ?? ""));

  const renderRow = (item: (typeof rows)[number]): JSX.Element =>
    item.kind === "user" ? (
      <UserMessageBubble
        content={item.text}
        images={item.images}
        files={item.files}
        dataId={`bot-message-user-${item.id}`}
      />
    ) : (
      // Consecutive bot bubbles sit closer together, as one person's run groups.
      <div
        className="flex flex-col items-start gap-1"
        data-id={`bot-message-agent-${item.id}`}
      >
        {item.items.map((part) =>
          part.kind === "text" ? (
            <BotBubble key={part.id}>
              <Markdown content={part.content} />
            </BotBubble>
          ) : part.kind === "notification" ? (
            wantsUpgradeCard(part.actions) ? (
              <div key={part.id} className="max-w-md">
                <PremiumUpgradeCard
                  dataId="chat-upgrade-card"
                  onSwitchModel={onSwitchModel}
                />
              </div>
            ) : (
              <BotBubble key={part.id} tone="notice">
                {part.message}
                {wantsModelSwitch(part.actions) && onSwitchModel != null && (
                  <Button
                    variant="secondary"
                    size="xs"
                    className="ms-2 align-middle"
                    data-id="notification-switch-model-btn"
                    onClick={onSwitchModel}
                  >
                    {t("workspace.switchModel")}
                  </Button>
                )}
              </BotBubble>
            )
          ) : part.kind === "subtask" ? (
            <BotSubtaskThread
              key={part.id}
              summary={part.summary}
              onOpen={
                onOpenSubtask == null
                  ? undefined
                  : () => onOpenSubtask(part.summary.id)
              }
            />
          ) : null
        )}
        {item.deliverables.length > 0 && (
          <div className={`${BUBBLE_MAX_WIDTH} w-full`}>
            <DeliverablesPill items={item.deliverables} />
          </div>
        )}
      </div>
    );

  return (
    <div className="flex flex-col gap-2" data-id="bot-message-list">
      {rows.map((item, index) => {
        const at = timeOf(item);
        const previous = index === 0 ? undefined : timeOf(rows[index - 1]);
        // The first dated message gets a stamp; after that only the far side of a gap.
        const stamped =
          at != null && (previous == null || at - previous >= QUIET_GAP_MS);

        return (
          <div key={item.id} className="contents">
            {stamped && (
              <div
                className="text-muted-foreground/80 py-2 text-center text-xs"
                data-id={`bot-message-stamp-${item.id}`}
              >
                {stampLabel(at, now)}
              </div>
            )}
            {renderRow(item)}
          </div>
        );
      })}
      {isWorking && <WorkingBubble />}
    </div>
  );
};
