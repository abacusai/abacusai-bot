import {
  Check,
  Compass,
  Boxes,
  Bot,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
/**
 * Every sub-agent this session has launched, in transcript order, from the
 * CLI's `subtask_start`/`subtask_end` brackets. Selecting one scopes the
 * transcript to that agent's own work.
 */
import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import { useSubtasks } from "../../conversation";
import type { SubtaskStatus } from "../../conversation";
import {
  useSubtaskScope,
  useSubtaskScopeStore,
} from "../../conversation/subtask-scope-store";
import { useWorkspaceActiveWorkspaceId } from "../../providers/workspace-state-provider";
import { useWorkspaceStore } from "../../stores/code-store";
import { Button, Spinner } from "../ui";

function statusIcon(status: SubtaskStatus): {
  icon: LucideIcon;
  className: string;
} {
  switch (status) {
    case "running":
      return { icon: LoaderCircle, className: "animate-spin text-primary" };
    case "interrupted":
      return { icon: TriangleAlert, className: "text-amber-400" };
    default:
      return { icon: Check, className: "text-green-400" };
  }
}

/**
 * Without a badge a component build, a delegated task and a browser session
 * are one anonymous row. An undefined kind renders no badge, not a wrong one.
 */
const KIND_BADGES: Record<string, { icon: LucideIcon; labelKey: string }> = {
  component: { icon: Boxes, labelKey: "workspace.agents.kind.component" },
  delegate: { icon: Bot, labelKey: "workspace.agents.kind.delegate" },
  browser: { icon: Compass, labelKey: "workspace.agents.kind.browser" },
};

function formatDuration(
  startTime: number | null,
  endTime: number | null
): string | null {
  if (startTime == null || endTime == null) return null;
  const seconds = Math.round((endTime - startTime) / 1000);
  if (seconds <= 0) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const AgentsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const subtasks = useSubtasks();
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  const activeSessionId = useWorkspaceStore((state) =>
    activeWorkspaceId == null
      ? null
      : (state.workspaceUiStates[activeWorkspaceId]?.activeSessionId ?? null)
  );
  const scope = useSubtaskScope(activeSessionId);
  const setScope = useSubtaskScopeStore((s) => s.setScope);

  if (subtasks.length === 0) {
    return (
      <div
        data-id="local-code-agents-empty"
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <Bot className="text-muted-foreground size-5 opacity-50" />
        <p className="text-secondary-foreground text-xs">
          {t("workspace.agents.emptyTitle")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("workspace.agents.emptyHint")}
        </p>
      </div>
    );
  }

  const select = (id: string): void => {
    if (activeSessionId == null) return;
    setScope(activeSessionId, scope === id ? null : id);
  };

  return (
    <div
      data-id="local-code-agents-panel"
      className="flex h-full flex-col overflow-y-auto p-2"
    >
      {activeSessionId != null && (
        <Button
          variant={scope == null ? "secondary" : "ghost"}
          size="sm"
          data-id="local-code-agents-main"
          onClick={() => setScope(activeSessionId, null)}
          className="mb-1 w-full justify-start"
        >
          <Bot className="text-muted-foreground" />
          <span className="font-medium">{t("workspace.agents.mainAgent")}</span>
        </Button>
      )}
      {subtasks.map((summary) => {
        const { icon, className } = statusIcon(summary.status);
        const duration = formatDuration(summary.startTime, summary.endTime);
        const isActive = scope === summary.id;
        const badge =
          summary.kind != null ? KIND_BADGES[summary.kind] : undefined;
        const StatusIcon = icon;
        const BadgeIcon = badge?.icon;
        return (
          <Button
            key={summary.id}
            variant={isActive ? "secondary" : "ghost"}
            size="sm"
            data-id={`local-code-agents-item-${summary.id}`}
            onClick={() => select(summary.id)}
            title={t("workspace.subtask.viewTranscript")}
            className="h-auto w-full min-w-0 flex-col items-stretch gap-0.5 py-1.5 text-left whitespace-normal"
          >
            <span className="flex min-w-0 items-center gap-2">
              {summary.status === "running" ? (
                <Spinner className="text-primary shrink-0" fontSize={11} />
              ) : (
                <StatusIcon className={`size-3 shrink-0 ${className}`} />
              )}
              <span className="min-w-0 truncate">
                {summary.description ?? t("workspace.subtask.working")}
              </span>
            </span>
            <span className="text-muted-foreground flex items-center gap-2 pl-5 text-xs">
              {badge != null && BadgeIcon != null && (
                <span className="border-border flex shrink-0 items-center gap-1 rounded border px-1 py-px text-[0.625rem]">
                  <BadgeIcon className="size-2.5" />
                  {t(badge.labelKey)}
                </span>
              )}
              {summary.status === "interrupted" && (
                <span className="shrink-0 text-amber-400">
                  {t("workspace.subtask.didNotFinish")}
                </span>
              )}
              {summary.toolCount > 0 && (
                <span>
                  {t("workspace.subtask.toolCount", {
                    count: summary.toolCount,
                  })}
                </span>
              )}
              {summary.status === "running" &&
                summary.lastToolLabel != null && (
                  <span className="min-w-0 truncate">
                    {summary.lastToolLabel}
                  </span>
                )}
              {duration != null && <span>{duration}</span>}
            </span>
          </Button>
        );
      })}
    </div>
  );
};
