import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Bot,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
/**
 * Sub-agent (subtask) UI for local Code mode: the card that stands in for a
 * `subtask_start` / `subtask_end` bracket in the main transcript, and the
 * header that frames the scoped view.
 */
import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { SubtaskStatus, SubtaskSummary } from "../../conversation";
import { Markdown } from "../common/markdown";
import { Button } from "../ui";
import { ShimmerText } from "./shimmer-text";

/** Status icon, tool-call card vocabulary: only in-flight gets an accent. */

export function statusIcon(status: SubtaskStatus): {
  icon: LucideIcon;
  className: string;
} {
  switch (status) {
    case "running":
      return { icon: LoaderCircle, className: "animate-spin text-primary" };
    case "interrupted":
      return { icon: TriangleAlert, className: "text-destructive" };
    default:
      return { icon: Check, className: "text-muted-foreground" };
  }
}

/** Card title per sub-agent kind; an absent kind keeps the generic "Agent". */
export const KIND_LABEL_KEYS: Record<string, string> = {
  component: "workspace.agents.kind.component",
  delegate: "workspace.agents.kind.delegate",
  browser: "workspace.agents.kind.browser",
};

export function formatDuration(
  startTime: number | null,
  endTime: number | null
): string | null {
  if (startTime == null || endTime == null) return null;
  const seconds = Math.round((endTime - startTime) / 1000);
  // A run that rounds to nothing is noise, not information.
  if (seconds <= 0) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Ticking elapsed time for a still-running sub-agent. */
export const LiveTimer = ({
  startTime,
}: {
  startTime: number;
}): JSX.Element | null => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const label = formatDuration(startTime, now);
  return label != null ? (
    <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
  ) : null;
};

/**
 * Stand-in for a sub-agent's work in the main transcript. The collapsed header
 * is a count ("Sub-agent · 3 tools"), never the model's free-text brief, which
 * makes a transcript read like a dispatch log. The row inside swaps the
 * transcript to the sub-agent's scoped view, filtered to its `subtaskId`.
 */
export const SubtaskCard = ({
  summary,
  onOpen,
}: {
  summary: SubtaskSummary;
  onOpen: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);
  const running = summary.status === "running";
  const isError = summary.status === "interrupted";
  const { icon, className } = statusIcon(summary.status);
  const StatusIcon = icon;
  const DisclosureIcon = collapsed ? ChevronRight : ChevronDown;
  const duration = formatDuration(summary.startTime, summary.endTime);

  const detailParts: string[] = [];
  // An unfinished sub-agent says so in words, not just the icon: its
  // deliverable does not exist.
  if (summary.status === "interrupted")
    detailParts.push(t("workspace.subtask.didNotFinish"));
  if (summary.toolCount > 0) {
    detailParts.push(
      t("workspace.subtask.toolCount", { count: summary.toolCount })
    );
  }
  if (running && summary.lastToolLabel != null)
    detailParts.push(summary.lastToolLabel);
  if (!running && duration != null) detailParts.push(duration);

  // The running state is carried by the spinner and shimmer, not a second
  // wording of it.
  const kindLabel =
    summary.kind != null && KIND_LABEL_KEYS[summary.kind] != null
      ? t(KIND_LABEL_KEYS[summary.kind]!)
      : t("workspace.subtask.agent");

  const label = [kindLabel, ...detailParts].join(" · ");
  // What the sub-agent has said, minus its final report once finished (that
  // renders in the main thread). While running, the latest lines show without
  // opening the card so a long task reads as progress rather than silence.
  const narration = running
    ? summary.narration
    : summary.narration.slice(0, -1);
  const liveNarration = running ? narration.slice(-3) : [];

  return (
    <div
      className={`my-1.5 overflow-hidden rounded-lg border transition-colors ${
        isError
          ? "border-destructive/30 bg-destructive/[0.04]"
          : "border-border bg-sidebar/50"
      }`}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="h-auto w-full justify-start gap-2 px-3 py-2 text-left font-normal"
      >
        <StatusIcon
          className={`shrink-0 ${running || isError ? "h-3 w-3" : "h-2.5 w-2.5"} ${className}`}
        />
        <span className="text-secondary-foreground min-w-0 flex-1 truncate text-xs">
          {running ? <ShimmerText>{label}</ShimmerText> : label}
        </span>
        {running && summary.startTime != null && (
          <LiveTimer startTime={summary.startTime} />
        )}
        <DisclosureIcon className="text-muted-foreground size-3 shrink-0" />
      </Button>
      {collapsed && liveNarration.length > 0 && (
        <NarrationList
          entries={liveNarration}
          kindLabel={kindLabel}
          live
          data-id={`local-code-subtask-live-${summary.id}`}
        />
      )}
      {!collapsed && (
        <div className="border-border/70 border-t p-1">
          <div className="text-secondary-foreground rounded-md px-2 py-1.5 text-xs leading-5">
            {summary.description ?? t("workspace.subtask.working")}
          </div>
          {narration.length > 0 && (
            <NarrationList entries={narration} kindLabel={kindLabel} />
          )}
          <Button
            variant="ghost"
            size="sm"
            data-id={`local-code-subtask-card-${summary.id}`}
            onClick={onOpen}
            title={t("workspace.subtask.viewTranscript")}
            className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
          >
            <Bot className="text-muted-foreground size-3 shrink-0" />
            <span className="text-secondary-foreground min-w-0 flex-1 truncate text-xs">
              {t("workspace.subtask.viewTranscript")}
            </span>
            <ChevronRight className="text-muted-foreground size-3 shrink-0" />
          </Button>
        </div>
      )}
    </div>
  );
};

/**
 * The sub-agent's own words, as small bubbles under its name, so the text is
 * plainly the sub-agent's and not the bot's.
 */
const NarrationList = ({
  entries,
  kindLabel,
  live = false,
  "data-id": dataId,
}: {
  entries: string[];
  kindLabel: string;
  live?: boolean;
  "data-id"?: string;
}): JSX.Element => (
  <div
    className={`border-border/70 flex flex-col gap-1.5 border-t px-3 py-2 ${live ? "" : "mt-1"}`}
    data-id={dataId}
  >
    {entries.map((entry, index) => (
      <div key={index} className="flex items-start gap-2">
        <Bot className="text-muted-foreground mt-1 size-3 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground text-[10px] tracking-wide uppercase">
            {kindLabel}
          </div>
          <div className="bg-background/70 text-secondary-foreground prose0 border-border/60 rounded-md border px-2 py-1 text-xs leading-5">
            <Markdown
              content={entry}
              className="prose dark:prose-invert max-w-none text-xs"
            />
          </div>
        </div>
      </div>
    ))}
  </div>
);

/**
 * A finished sub-agent's report, rendered in full in the main thread: the
 * parent agent is told not to restate it, so a truncated preview would drop
 * the turn's actual answer.
 */

export const SubtaskReport = ({
  summary,
}: {
  summary: SubtaskSummary;
}): JSX.Element | null => {
  if (summary.status === "running" || summary.textFinal == null) return null;
  return (
    <div
      className="prose0 min-w-0 text-xs leading-relaxed"
      data-id="local-code-subtask-report"
    >
      <Markdown
        content={summary.textFinal}
        className="prose dark:prose-invert text-foreground max-w-none"
      />
    </div>
  );
};

/** Header bar for the scoped sub-agent view, with the way back to the main thread. */
export const SubtaskScopeHeader = ({
  summary,
  onBack,
}: {
  summary: SubtaskSummary | undefined;
  onBack: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const { icon, className } = statusIcon(summary?.status ?? "completed");
  const StatusIcon = icon;
  return (
    <div className="border-border bg-background/95 sticky top-0 z-10 flex items-center gap-2 border-b px-2 py-1.5 text-xs backdrop-blur">
      <Button
        variant="ghost"
        size="xs"
        data-id="local-code-subtask-back"
        onClick={onBack}
        title={t("workspace.subtask.backToMain")}
        className="text-muted-foreground px-1 font-normal"
      >
        <ArrowLeft className="size-2.5" />
        {t("workspace.subtask.main")}
      </Button>
      <span className="text-muted-foreground">/</span>
      <StatusIcon className={`size-3 shrink-0 ${className}`} />
      <span className="text-foreground min-w-0 truncate font-medium">
        {summary?.description ?? t("workspace.subtask.agent")}
      </span>
    </div>
  );
};
