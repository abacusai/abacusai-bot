/**
 * `SubagentCard` (spec 02 §5.5): one 52 px row per sub-agent (adjacent rows
 * group into one rounded card), expandable into the child's parts, which
 * render through the same widget context (no override maps, F7). Stop stops
 * the whole reply (`ai.cancel`, F11); `handle.stop` is never called.
 */
import type { UIMessage } from "@tanstack/ai-client";
import type { SubagentProps } from "@tanstack/ai-react/ui";
import { ChevronRight, ExternalLink, Square } from "lucide-react";
import { type ComponentType } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { useToolWindow } from "../../scroller/row-context";
import { useThreadStore } from "../../store/selectors";
import { formatElapsed, useSeconds } from "../clock";
import { SubagentScope, useChatView } from "../context";
import { toolTitle } from "../tools/tool-line";

const stepsOf = (messages: readonly UIMessage[]): number =>
  messages.reduce(
    (count, message) =>
      count + message.parts.filter((part) => part.type === "tool-call").length,
    0
  );

const latestTool = (messages: readonly UIMessage[]): string | null => {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const parts = messages[m]!.parts;
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const part = parts[p]!;
      if (part.type === "tool-call")
        return toolTitle(
          part.name,
          (part.input as Record<string, unknown> | undefined) ?? {}
        );
    }
  }
  return null;
};

const KIND_KEYS: Record<string, string> = {
  delegate: "chat.subagent.kind.delegate",
  browser: "chat.subagent.kind.browser",
  component: "chat.subagent.kind.component",
};

export const SubagentCard = (props: SubagentProps<unknown>) => {
  const window = useToolWindow();
  const index = window?.ids.indexOf(`card\0${props.subagent.id}`) ?? -1;
  if (
    window != null &&
    index >= 0 &&
    (index < window.range.start || index >= window.range.end)
  )
    return null;
  return <MountedSubagentCard {...props} />;
};
const MountedSubagentCard = ({ subagent, Parts }: SubagentProps<unknown>) => {
  const { t } = useTranslation();
  const { runtime, threadId, session, onOpenSubagent } = useChatView();
  const running =
    subagent.status === "running" || subagent.status === "suspended";
  const now = useSeconds(running);
  const times = useThreadStore(
    session,
    (state) => state.subagentTimes[subagent.id]
  );
  const started = times?.start ?? now;
  const steps = stepsOf(subagent.messages);
  const description = (subagent as { description?: string }).description;
  const name =
    description ?? t(KIND_KEYS[subagent.name] ?? "chat.subagent.kind.generic");
  const sub = running
    ? [
        latestTool(subagent.messages),
        t("chat.subagent.steps", { count: steps }),
      ]
        .filter(Boolean)
        .join(" · ")
    : subagent.status === "error"
      ? (subagent.error?.message ?? t("chat.subagent.failed"))
      : t("chat.subagent.done", {
          count: steps,
          duration: formatElapsed((times?.end ?? now) - started),
        });
  const PartsView = Parts as ComponentType;
  return (
    <Collapsible
      data-slot="subagent-row"
      data-status={subagent.status}
      className="rounded-xl bg-[var(--chat-surface-2)] [&+[data-slot=subagent-row]]:-mt-1"
    >
      <div className="flex min-h-13 items-center gap-3 px-3">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            running
              ? "bg-[var(--chat-status-running)]"
              : subagent.status === "error"
                ? "bg-destructive"
                : "bg-[var(--chat-status-done)]"
          )}
        />
        <CollapsibleTrigger className="group/sub focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 text-start outline-none focus-visible:ring-2">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{name}</span>
            <span
              className={cn(
                "truncate text-xs",
                subagent.status === "error"
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {sub}
            </span>
          </span>
          <ChevronRight
            aria-hidden
            className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[panel-open]/sub:rotate-90"
          />
        </CollapsibleTrigger>
        {onOpenSubagent != null ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("chat.subagent.open")}
            onClick={() => onOpenSubagent(subagent.id)}
          >
            <ExternalLink aria-hidden />
          </Button>
        ) : null}
        {running ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("chat.subagent.stop")}
                  onClick={() => void runtime.cancel(threadId)}
                />
              }
            >
              <Square aria-hidden />
            </TooltipTrigger>
            <TooltipContent>{t("chat.subagent.stopHint")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <CollapsibleContent className="flex flex-col gap-1 px-4 pb-3">
        <SubagentScope value={subagent.id}>
          <PartsView />
        </SubagentScope>
      </CollapsibleContent>
    </Collapsible>
  );
};

export const subagentWidgets = new Proxy(
  {} as Record<string, typeof SubagentCard>,
  {
    get: (_target, name) =>
      typeof name === "string" ? SubagentCard : undefined,
  }
) as Record<string, typeof SubagentCard>;
