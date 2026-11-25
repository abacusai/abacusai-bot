/**
 * The Agents tab's list: one row per sub-agent with a status icon, its kind,
 * tool count, the tool it is on, and a live timer (old `AgentsPanel`).
 */
import {
  Boxes,
  Bot,
  Check,
  Compass,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";

import type { ChatRuntime } from "../../runtime/runtime";
import { useThreadStore } from "../../store/selectors";
import { formatElapsed, useSeconds } from "../clock";
import { KIND_KEYS, latestTool, stepsOf } from "./subagent-card";
import { subagentEnding } from "./summary";
import { useSubagents } from "./use-subagents";

const KIND_ICONS = { component: Boxes, delegate: Bot, browser: Compass };

type Agent = ReturnType<typeof useSubagents>[number];

const AgentRow = ({
  runtime,
  threadId,
  agent,
  selected,
  onSelect,
}: {
  runtime: ChatRuntime;
  threadId: string;
  agent: Agent;
  selected: boolean;
  onSelect: (id: string) => void;
}) => {
  const { t } = useTranslation();
  const running = agent.status === "running" || agent.status === "suspended";
  const now = useSeconds(running);
  const times = useThreadStore(
    runtime.session(threadId),
    (state) => state.subagentTimes[agent.id]
  );
  const failed = agent.status === "error";
  const unfinished =
    subagentEnding(agent as Parameters<typeof subagentEnding>[0]) != null;
  const steps = stepsOf(agent.messages);
  const tool = running ? latestTool(agent.messages) : null;
  const elapsed =
    times != null ? formatElapsed((times.end ?? now) - times.start) : null;
  const Icon = running
    ? LoaderCircle
    : failed || unfinished
      ? TriangleAlert
      : Check;
  const KindIcon = KIND_ICONS[agent.name as keyof typeof KIND_ICONS];
  const name =
    (agent as { description?: string }).description ??
    t(KIND_KEYS[agent.name] ?? "chat.subagent.kind.generic");
  return (
    <button
      type="button"
      data-slot="agent-row"
      data-status={agent.status}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(agent.id)}
      title={t("workspace.subtask.viewTranscript")}
      className={cn(
        "hover:bg-accent focus-visible:ring-ring flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-start outline-none focus-visible:ring-2",
        selected && "bg-accent"
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            running && "text-primary animate-spin",
            failed && "text-failed",
            unfinished && !failed && "text-amber-400",
            !running &&
              !failed &&
              !unfinished &&
              "text-[var(--chat-status-done)]"
          )}
        />
        <span className="truncate">{name}</span>
      </span>
      <span className="text-muted-foreground flex min-w-0 items-center gap-2 ps-5.5 text-xs">
        {KindIcon != null ? (
          <span className="border-border flex shrink-0 items-center gap-1 rounded border px-1 py-px text-[0.625rem]">
            <KindIcon aria-hidden className="size-2.5" />
            {t(KIND_KEYS[agent.name]!)}
          </span>
        ) : null}
        {unfinished ? (
          <span className="shrink-0">
            {t("workspace.subtask.didNotFinish")}
          </span>
        ) : null}
        {steps > 0 ? (
          <span className="shrink-0">
            {t("workspace.subtask.toolCount", { count: steps })}
          </span>
        ) : null}
        {tool != null ? <span className="min-w-0 truncate">{tool}</span> : null}
        {elapsed != null ? (
          <span className="shrink-0 tabular-nums">{elapsed}</span>
        ) : null}
      </span>
    </button>
  );
};

export const AgentsList = ({
  runtime,
  threadId,
  selected,
  onSelect,
}: {
  runtime: ChatRuntime;
  threadId: string;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) => {
  const agents = useSubagents(runtime, threadId);
  return (
    <div data-slot="agents-list" className="flex flex-col gap-0.5">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          runtime={runtime}
          threadId={threadId}
          agent={agent}
          selected={selected === agent.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
};
