/**
 * Status components (spec 02 §5.6): the sessions busy line, the bots typing
 * bubble, run outcome markers, the error card with its action table (and
 * the upgrade variant), and notices.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  ABACUS_BUY_CREDITS_URL,
  ABACUS_PLAN_URL,
} from "#next/lib/abacus-links";
import { cn } from "#next/lib/cn";
import { Button } from "#next/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#next/ui/hover-card";
import { Marker, MarkerContent, MarkerIcon } from "#next/ui/marker";

import type {
  Notice,
  RunOutcomeRecord,
  ThreadStoreState,
} from "../../store/thread-store";
import { formatElapsed, useSeconds } from "../clock";
import { useChatView } from "../context";
import { toolTitle } from "../tools/tool-line";

interface ErrorAction {
  type: string;
  model?: string;
  label?: string;
  link?: string;
}

/** The running tool calls of the active run (the busy line's label). */
export const runningTools = (messages: readonly UIMessage[]): string[] => {
  const titles: string[] = [];
  const last = messages.findLast((message) => message.role === "assistant");
  if (last == null) return titles;
  const results = new Set(
    last.parts
      .filter((part) => part.type === "tool-result")
      .map((part) => part.toolCallId)
  );
  for (const part of last.parts)
    if (
      part.type === "tool-call" &&
      !results.has(part.id) &&
      part.output == null
    )
      titles.push(
        toolTitle(
          part.name,
          (part.input as Record<string, unknown> | undefined) ?? {}
        )
      );
  return titles;
};

export const busyLabel = (
  t: (key: string, values?: Record<string, unknown>) => string,
  input: {
    state: ThreadStoreState;
    running: string[];
    agents: number;
  }
): string => {
  const { state, running, agents } = input;
  if (state.permissions.items.length > 0) return t("chat.busy.needsYou");
  if (state.activity.retry != null)
    return t("chat.busy.retrying", {
      attempt: state.activity.retry.attempt,
      max: state.activity.retry.maxAttempts,
    });
  if (agents > 0) return t("chat.busy.agents", { count: agents });
  if (running.length === 1) return running[0]!;
  if (running.length > 1)
    return t("chat.busy.tools", { count: running.length });
  if (state.activity.runningTools > 1)
    return t("chat.busy.tools", { count: state.activity.runningTools });
  return t("chat.busy.working");
};

export const BusyLine = ({
  label,
  startedAt,
}: {
  label: string;
  startedAt: number;
}) => {
  const now = useSeconds(true);
  return (
    <div
      className="text-muted-foreground flex items-center gap-2 text-[13px] font-medium"
      data-slot="busy-line"
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-[var(--chat-status-running)]"
      />
      <span className="min-w-0 truncate">{label}</span>
      <span className="chat-mono font-normal">
        {formatElapsed(now - startedAt)}
      </span>
    </div>
  );
};

export const Typing = ({ caption }: { caption?: string | null }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2" data-slot="typing">
      <div
        role="img"
        aria-label={t("chat.busy.typing")}
        className="text-muted-foreground flex h-9 items-center gap-1 rounded-[20px] rounded-bl-md bg-[var(--chat-surface)] px-3.5"
      >
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
      </div>
      {caption != null && caption !== "" ? (
        <span className="text-muted-foreground truncate text-xs">
          {caption}
        </span>
      ) : null}
    </div>
  );
};

const formatTokens = (value: number | undefined): string =>
  value == null
    ? "0"
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value);

export const RunMarker = ({ outcome }: { outcome: RunOutcomeRecord }) => {
  const { t } = useTranslation();
  if (outcome.kind === "cancelled")
    return (
      <div
        className="text-muted-foreground flex items-center gap-2 text-[13px]"
        data-slot="run-marker"
        data-kind="cancelled"
      >
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-[var(--chat-status-muted)]"
        />
        {t("chat.run.stopped")}
      </div>
    );
  const label = t("chat.run.done", {
    duration: formatElapsed(outcome.endedAt - outcome.startedAt),
    count: outcome.steps,
  });
  const marker = (
    <div
      className="text-muted-foreground flex items-center gap-2 text-[13px]"
      data-slot="run-marker"
      data-kind="success"
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-[var(--chat-status-done)]"
      />
      {label}
    </div>
  );
  if (outcome.usage == null) return marker;
  const usage = outcome.usage;
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <div
            tabIndex={0}
            className="focus-visible:ring-ring w-fit rounded-md outline-none focus-visible:ring-2"
          />
        }
      >
        {marker}
      </HoverCardTrigger>
      <HoverCardContent className="w-auto text-xs">
        {t("chat.run.usage", {
          input: formatTokens(usage.inputTokens),
          cached: formatTokens(usage.cachedInputTokens),
          output: formatTokens(usage.outputTokens),
        })}
      </HoverCardContent>
    </HoverCard>
  );
};

const wantsUpgradeCard = (actions?: ErrorAction[]): boolean =>
  actions?.some(
    (action) =>
      action.type === "upgrade-abacus" || action.type === "free-pool-out"
  ) === true;

const exhaustedScope = (actions?: ErrorAction[]): "abacus" | "pool" =>
  actions?.some((action) => action.type === "upgrade-abacus") === true
    ? "abacus"
    : "pool";

const freeModelSwitches = (
  actions?: ErrorAction[]
): Array<{ model: string; label: string }> =>
  (actions ?? []).flatMap((action) =>
    action.type === "switch-model" && action.model != null
      ? [{ model: action.model, label: action.label ?? action.model }]
      : []
  );

export interface ErrorCardProps {
  outcome: RunOutcomeRecord;
  /** The latest terminal while the thread is idle (Retry is offered then). */
  latest: boolean;
  tier?: "free" | "basic" | "paid" | "unknown";
}

export const ErrorCard = ({
  outcome,
  latest,
  tier = "unknown",
}: ErrorCardProps) => {
  const { t } = useTranslation();
  const { session, composer, runtime } = useChatView();
  const error = outcome.error ?? { message: "" };
  const actions = ((error as { actions?: ErrorAction[] }).actions ??
    []) as ErrorAction[];
  const detail = (error as { detail?: string }).detail;
  const crashed = error.code === "agent_exit" || error.code === "agent_crashed";
  const retry = () => void session.retry();
  if (wantsUpgradeCard(actions)) {
    const scope = exhaustedScope(actions);
    return (
      <div
        role="group"
        aria-label={t("chat.error.label")}
        className="flex flex-col gap-3 rounded-2xl bg-[var(--chat-surface)] p-4 text-sm"
        data-slot="error-card"
        data-variant="upgrade"
      >
        <div className="font-medium">
          {tier === "paid"
            ? t("creditsCard.paidTitle")
            : scope === "pool"
              ? t("workspace.premiumUpgrade.poolOutTitle")
              : t("workspace.premiumUpgrade.exhaustedTitle")}
        </div>
        <p className="text-muted-foreground">
          {tier === "paid"
            ? t("creditsCard.paidBody")
            : t("workspace.premiumUpgrade.switchNote")}
        </p>
        <div className="flex flex-wrap gap-2">
          {freeModelSwitches(actions).map((choice) => (
            <Button
              key={choice.model}
              variant="secondary"
              onClick={() => composer.model?.onChange(choice.model)}
            >
              {t("workspace.premiumUpgrade.continueOn", {
                model: choice.label,
              })}
            </Button>
          ))}
          <Button
            onClick={() =>
              void runtime.host.openExternal(
                tier === "paid" ? ABACUS_BUY_CREDITS_URL : ABACUS_PLAN_URL
              )
            }
          >
            {t("creditsCard.topUpCta")}
          </Button>
        </div>
      </div>
    );
  }
  const buttons = actions.flatMap((action, index) => {
    switch (action.type) {
      case "retry":
        return latest
          ? [
              <Button key={index} variant="secondary" onClick={retry}>
                {t("chat.error.retry")}
              </Button>,
            ]
          : [];
      case "switch-model":
        return action.model != null
          ? [
              <Button
                key={index}
                variant="secondary"
                onClick={() => composer.model?.onChange(action.model!)}
              >
                {t("workspace.premiumUpgrade.continueOn", {
                  model: action.label ?? action.model,
                })}
              </Button>,
            ]
          : composer.model != null
            ? [
                <Button
                  key={index}
                  variant="secondary"
                  data-action="switch-model"
                >
                  {t("chat.error.switchModel")}
                </Button>,
              ]
            : [];
      default:
        return action.link != null
          ? [
              <Button
                key={index}
                variant="secondary"
                onClick={() => void runtime.host.openExternal(action.link!)}
              >
                {action.label ?? t("chat.error.open")}
              </Button>,
            ]
          : [];
    }
  });
  if (crashed && latest && !actions.some((action) => action.type === "retry"))
    buttons.push(
      <Button key="retry" variant="secondary" onClick={retry}>
        {t("chat.error.retry")}
      </Button>
    );
  return (
    <div
      role="group"
      aria-label={t("chat.error.label")}
      className="bg-destructive/10 dark:bg-destructive/15 flex flex-col gap-2 rounded-2xl p-4 text-sm"
      data-slot="error-card"
    >
      <div className="flex items-start gap-2">
        <XCircle
          aria-hidden
          className="text-destructive mt-0.5 size-4 shrink-0"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">
            {crashed ? t("chat.error.crashed") : error.message}
          </div>
          {detail != null && detail !== "" ? (
            <div className="text-muted-foreground text-xs">{detail}</div>
          ) : null}
        </div>
      </div>
      {buttons.length > 0 ? (
        <div className="flex flex-wrap gap-2 ps-6">{buttons}</div>
      ) : null}
    </div>
  );
};

const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

const SEVERITY_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

export const NoticeRow = ({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss(): void;
}) => {
  const { t } = useTranslation();
  const { runtime } = useChatView();
  const severity = (
    notice.name === "agent.error"
      ? "error"
      : notice.name === "abacus.notice"
        ? "warning"
        : String(notice.value.severity ?? "info")
  ) as keyof typeof SEVERITY_ICON;
  const Icon = SEVERITY_ICON[severity] ?? Info;
  const actions = (notice.value.actions as ErrorAction[] | undefined) ?? [];
  // Main's own notice about the thread (a v1 history too large to read).
  const tooLarge =
    notice.name === "abacus.notice" && notice.value.kind === "too-large";
  const historyPath =
    typeof notice.value.path === "string" ? notice.value.path : null;
  const message = tooLarge
    ? t("chat.notice.historyTooLarge", {
        size: formatBytes(Number(notice.value.size ?? 0)),
        limit: formatBytes(Number(notice.value.limit ?? 0)),
      })
    : String(notice.value.message ?? "");
  return (
    <Marker
      variant="border"
      className="items-start"
      data-slot="notice"
      data-severity={severity}
    >
      <MarkerIcon>
        <Icon
          aria-hidden
          className={cn(
            severity === "error" && "text-destructive",
            severity === "warning" && "text-[var(--chat-status-attention)]"
          )}
        />
      </MarkerIcon>
      <MarkerContent className="flex-1">{message}</MarkerContent>
      {tooLarge && historyPath != null ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void runtime.host.showItemInFolder(historyPath)}
        >
          {t("chat.notice.showInFolder")}
        </Button>
      ) : null}
      {actions
        .filter((action) => action.link != null)
        .map((action, index) => (
          <Button
            key={index}
            variant="ghost"
            size="sm"
            onClick={() => void runtime.host.openExternal(action.link!)}
          >
            {action.label ?? t("chat.error.open")}
          </Button>
        ))}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("chat.notice.dismiss")}
        onClick={onDismiss}
      >
        <X aria-hidden />
      </Button>
    </Marker>
  );
};
