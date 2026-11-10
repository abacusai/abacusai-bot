/**
 * Status components (spec 02 §5.6): the sessions busy line, the bots typing
 * bubble, run outcome markers, the error card with its action table (and
 * the upgrade variant), and notices.
 */
import { toolActivity } from "@abacus-ai/agent/tool-display";
import {
  type BillingPlan,
  type PaidCreditsOffer,
  paidCreditsOffer,
  paidUpgradeOnly,
} from "@abacus-ai/contract/billing-plan";
import {
  CREDITS_LOW_NOTICE_ACTION,
  creditMilestonePlan,
  milestoneOffer,
} from "@abacus-ai/contract/credit-thresholds";
import { OPENLLM_ID } from "@abacus-ai/contract/models";
import { providerDisplayName } from "@abacus-ai/contract/settings";
import type { UIMessage } from "@tanstack/ai-client";
import { Store, useStore } from "@tanstack/react-store";
import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Info,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CreditsCard,
  creditWallTitle,
} from "#renderer/components/credits-card";
import {
  CutOffCard,
  type CutOffResolution,
  type CutOffState,
  ModelUnavailableCard,
  PlanOffer,
} from "#renderer/components/credits-card/model-unavailable";
import { PaidOfferButtons } from "#renderer/components/credits-card/paid-offer";
import { GroupCard } from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import {
  ABACUS_AGENT_URL,
  ABACUS_BILLING_URL,
  ABACUS_BUY_CREDITS_URL,
  ABACUS_VERIFY_PHONE_URL,
} from "#renderer/lib/abacus-links";
import { latestPresented } from "#renderer/lib/bot-turns/deliverables";
import { cn } from "#renderer/lib/cn";
import { CREDITS_EXHAUSTED_TTL_MS } from "#renderer/lib/credits";
import {
  freeCreditsHeld,
  freeCreditsUnlocked,
  startFreeCreditsWatch,
  useFreeCreditsVerifySurface,
} from "#renderer/lib/free-credits-watch";
import { AppLink } from "#renderer/lib/navigation/app-link";
import {
  MOVED_TO_ABACUS_ACTION,
  ownKeyFailure,
  ownKeyMovedLine,
  ownKeyWords,
  type OwnKeyFailure,
} from "#renderer/lib/own-key-unavailable";
import { IS_ELECTRON } from "#renderer/lib/platform";
import {
  lastUserText,
  requestUpgradeDialog,
  startCreditsCheckout,
  startPlanCheckout,
  taskText,
} from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#renderer/ui/hover-card";
import { Marker, MarkerContent, MarkerIcon } from "#renderer/ui/marker";

import type {
  Notice,
  RunOutcomeRecord,
  ThreadStoreState,
} from "../../store/thread-store";
import { formatElapsed, useSeconds } from "../clock";
import { useChatView } from "../context";
import { openModelPicker } from "../open-model-picker";
import { toolTitle } from "../tools/tool-line";
import { creditsExpired, useUpgradeResume } from "../upgrade-triggers";
import { TurnCredits } from "./turn-credits";

export const providerMessage = (raw = ""): string => {
  const start = raw.indexOf("{");
  if (start < 0) return raw.replace(/^\d{3}\s+/, "");
  try {
    const value = JSON.parse(raw.slice(start));
    const message = value?.error?.message ?? value?.message ?? value?.error;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
};

interface ErrorAction {
  type: string;
  model?: string;
  label?: string;
  link?: string;
  provider?: string;
  cause?: string;
  /** `continue-free`: the free lane's providers, in order. */
  providers?: string[];
  /** `verify-phone`: the free credits verifying unlocks, as the server names them. */
  credits?: string;
  /** `cut-off`: part of the reply arrived before the cut. */
  streamed?: boolean;
  /** `retry` on a full disk: the bytes left where the agent writes. */
  bytesFree?: number;
  /** `spend-limit`: the limit's size; `credits-low`: the credits left. */
  amount?: number;
  /** `switch-model` at the credit wall: the model is on the user's own key. */
  ownKey?: boolean;
}

/** Why the turn did not finish, as the agent named it (turn-outcome.ts). */
const OUTCOME_CAUSES = new Set([
  "context_too_long",
  "key_invalid",
  "own_key_quota",
  "model_unavailable",
  "free_pool_spent",
  "rate_limited",
  "empty",
  "unknown",
]);

type RunningCall = { id: string; name: string; title: string };

/** The tool calls of the active run still waiting on a result. */
const runningCalls = (messages: readonly UIMessage[]): RunningCall[] => {
  const calls: RunningCall[] = [];
  const last = messages.findLast((message) => message.role === "assistant");
  if (last == null) return calls;
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
      calls.push({
        id: part.id,
        name: part.name,
        title: toolTitle(
          part.name,
          (part.input as Record<string, unknown> | undefined) ?? {}
        ),
      });
  return calls;
};

/** The running tool calls of the active run (the busy line's label). */
export const runningTools = (messages: readonly UIMessage[]): string[] =>
  runningCalls(messages).map((call) => call.title);

/** How long a tool runs before the busy line says what it is doing in plain words. */
const LONG_TOOL_MS = 60_000;
/**
 * When each running call was first seen, per thread: its own clock, not the
 * turn's, kept while the user looks at another chat.
 */
const callSeenAt = new Map<string, Map<string, number>>();

/** The ids of the active run's running calls, as one dependency key. */
export const runningCallKey = (messages: readonly UIMessage[]): string =>
  runningCalls(messages)
    .map((call) => call.id)
    .join("\n");

/** Starts the clock of each newly running call (from an effect: it reads the time). */
export const noteRunningCalls = (
  thread: string,
  key: string,
  now: number
): void => {
  const live = new Set(key === "" ? [] : key.split("\n"));
  const seen = callSeenAt.get(thread) ?? new Map<string, number>();
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
  for (const id of live) if (!seen.has(id)) seen.set(id, now);
  if (seen.size > 0) callSeenAt.set(thread, seen);
  else callSeenAt.delete(thread);
};

/**
 * One tool running past a minute, in words anyone reads, with its own time:
 * "Running a command · 4 min" rather than a raw shell line. Null before then,
 * or while several run. A tool with no plain phrase keeps its own title.
 */
export const longToolLabel = (
  t: (key: string, values?: Record<string, unknown>) => string,
  thread: string,
  messages: readonly UIMessage[],
  now: number
): string | null => {
  const calls = runningCalls(messages);
  if (calls.length !== 1) return null;
  const call = calls[0]!;
  const seenAt = callSeenAt.get(thread)?.get(call.id);
  if (seenAt == null || now - seenAt < LONG_TOOL_MS) return null;
  const activity = toolActivity(call.name);
  return t("chat.busy.longTool", {
    activity:
      activity == null ? call.title : t(`chat.busy.activity.${activity}`),
    minutes: Math.floor((now - seenAt) / 60_000),
  });
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
  if (state.activity.retry?.waitingForConnection === true)
    return t("chat.busy.waitingForConnection");
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
      // The live twin of a tool group's header: same height, same left edge
      // (a 14 px icon cell), same type.
      className="text-muted-foreground flex min-h-7 items-center gap-2 text-xs"
      data-slot="busy-line"
    >
      <span
        aria-hidden
        className="flex size-3.5 shrink-0 items-center justify-center"
      >
        <span className="size-1.5 rounded-full bg-[var(--chat-status-running)]" />
      </span>
      <span className="shimmer min-w-0 truncate">{label}</span>
      <span className="chat-mono font-normal">
        {formatElapsed(now - startedAt)}
      </span>
    </div>
  );
};

export const Typing = ({ caption }: { caption?: string | null }) => {
  const { t } = useTranslation();
  return (
    <div
      className="flex max-w-full min-w-0 flex-col items-start gap-1.5"
      data-slot="typing"
    >
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
        <span
          title={caption}
          className="text-muted-foreground max-w-full min-w-0 truncate text-xs"
        >
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

/**
 * A reply the free lane gave: which provider, and the way back to the top
 * models. Shown while the credit wall stands; gone once the credits are back.
 */
export const FreeLaneChip = ({ provider }: { provider: string | null }) => {
  const { t } = useTranslation();
  const { runtime } = useChatView();
  const prefs = usePrefs();
  const now = useNow();
  if (
    prefs.creditsExhaustedAt == null ||
    now - prefs.creditsExhaustedAt >= CREDITS_EXHAUSTED_TTL_MS
  )
    return null;
  return (
    <div
      data-slot="free-lane-chip"
      className="flex w-fit flex-wrap items-center gap-1.5 rounded-md bg-[color-mix(in_oklch,var(--chat-status-attention)_12%,transparent)] px-2 py-0.5 text-xs"
    >
      <AlertTriangle
        aria-hidden
        className="size-3 text-[var(--chat-status-attention)]"
      />
      <span>
        {t("outcome.freeChip", {
          provider:
            provider != null
              ? providerDisplayName(provider)
              : t("outcome.freeChipAny"),
        })}
      </span>
      <Button
        variant="link"
        size="xs"
        className="h-auto px-0"
        onClick={() => void runtime.host.openUpgrade("free_lane")}
      >
        {t("outcome.freeChipUpgrade")}
      </Button>
    </div>
  );
};

export const RunMarker = ({
  outcome,
  latest = false,
}: {
  outcome: RunOutcomeRecord;
  latest?: boolean;
}) => {
  const marker = (
    <div className="flex flex-wrap items-center gap-x-2">
      <RunMarkerLine outcome={outcome} />
      {outcome.kind === "success" && (
        <TurnCredits outcome={outcome} latest={latest} />
      )}
    </div>
  );
  if (outcome.kind !== "success" || outcome.freeLane == null) return marker;
  return (
    <div className="flex flex-col gap-1">
      {marker}
      <FreeLaneChip provider={outcome.freeLane.provider} />
    </div>
  );
};

const RunMarkerLine = ({ outcome }: { outcome: RunOutcomeRecord }) => {
  const { t } = useTranslation();
  if (outcome.kind === "cancelled")
    return (
      <div
        className="text-muted-foreground flex min-h-7 items-center gap-2 text-xs"
        data-slot="run-marker"
        data-kind="cancelled"
      >
        <span
          aria-hidden
          className="flex size-3.5 shrink-0 items-center justify-center"
        >
          <span className="size-1.5 rounded-full bg-[var(--chat-status-muted)]" />
        </span>
        {t("chat.run.stopped")}
      </div>
    );
  const label = t("chat.run.done", {
    duration: formatElapsed(outcome.endedAt - outcome.startedAt),
    count: outcome.steps,
  });
  const marker = (
    <div
      className="text-muted-foreground flex min-h-7 items-center gap-2 text-xs"
      data-slot="run-marker"
      data-kind="success"
    >
      <span
        aria-hidden
        className="flex size-3.5 shrink-0 items-center justify-center"
      >
        <span className="size-1.5 rounded-full bg-[var(--chat-status-done)]" />
      </span>
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

/** A busy free pool sells a plan to a free account only; a paying one switches. */
const wantsUpgradeCard = (actions?: ErrorAction[], paying = false): boolean =>
  actions?.some(
    (action) =>
      action.type === "upgrade-abacus" ||
      (action.type === "free-pool-out" && !(paying && action.cause === "busy"))
  ) === true;

/** The picked model that cannot serve the turn, when that is why it ended. */
const modelUnavailable = (actions?: ErrorAction[]): ErrorAction | undefined =>
  actions?.find((action) => action.type === "model-unavailable");

const exhaustedScope = (actions?: ErrorAction[]): "abacus" | "pool" =>
  actions?.some((action) => action.type === "upgrade-abacus") === true
    ? "abacus"
    : "pool";

/** The kept message goes again on RouteLLM - Open, by the person's choice. */
const useSwitchToAbacus = () => {
  const { t } = useTranslation();
  const { session, composer } = useChatView();
  return () =>
    void (async () => {
      await composer.onResumeOnFreePool?.();
      await session.retry(
        {
          model: OPENLLM_ID,
          ...(composer.fixedMode ? { mode: composer.fixedMode } : {}),
        },
        t("workspace.retryMessage")
      );
    })().catch(() => {});
};

/**
 * A turn on a model Abacus does not serve (the person's own key, another
 * provider's free model, their local server) that did not finish and did not
 * move to RouteLLM - Open, in place of the provider's error: what happened,
 * by model and provider, and why. A free account gets the model-unavailable
 * card: RouteLLM - Open while Abacus credits are left, the plan's whole offer
 * once they are used up. A paid or unread one already has the top models in
 * AbacusAI Agent on the web.
 */
const OwnKeyCard = ({
  failure,
  tier,
  runId,
  credits,
  latest,
}: {
  failure: OwnKeyFailure;
  tier: NonNullable<ErrorCardProps["tier"]>;
  runId: string;
  /** Abacus credits are left: RouteLLM - Open is the way on. */
  credits: boolean;
  latest: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer, runtime } = useChatView();
  const resume = useUpgradeResume();
  const switchToAbacus = useSwitchToAbacus();
  const canReply = composer.readOnly == null;
  const pickModel = canReply && composer.model != null;
  const { title, why } = ownKeyWords(failure, t);
  return (
    <div
      role="group"
      aria-label={t("chat.error.label")}
      className="mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)]"
      data-slot="error-card"
      data-variant="own-key"
      data-cause={failure.cause}
    >
      {tier === "free" ? (
        <ModelUnavailableCard
          host={runtime.host}
          kind="retired"
          label={failure.label ?? ""}
          title={title}
          why={why}
          creditsOut={!credits}
          {...(credits && latest && canReply && { onSwitch: switchToAbacus })}
          {...(pickModel && { onPickModel: openModelPicker })}
          {...(canReply && {
            onUpgrade: () =>
              requestUpgradeDialog(
                {
                  kind: "own-key",
                  key: `own-key-card:${runId}:${Date.now()}`,
                  threadId: session.threadId,
                  pendingText: lastUserText(session.hostStore.state.messages),
                  ownKey: failure,
                  resume,
                },
                true
              ),
          })}
        />
      ) : (
        <GroupCard title={title}>
          <div className="text-muted-foreground flex flex-col gap-1 p-3 text-sm">
            <p data-slot="own-key-why">{why}</p>
            <p>{t("ownKey.paidBody")}</p>
          </div>
          <div className="flex flex-wrap gap-2 p-3">
            <Button
              size="sm"
              data-action="open-abacus-agent"
              onClick={() => void runtime.host.openExternal(ABACUS_AGENT_URL)}
            >
              {t("ownKey.openAgent")}
            </Button>
            {pickModel && (
              <Button
                size="sm"
                variant="secondary"
                data-action="pick-model"
                onClick={(event) => openModelPicker(event.currentTarget)}
              >
                {t("outcome.unavailable.pickModel")}
              </Button>
            )}
          </div>
        </GroupCard>
      )}
    </div>
  );
};

/**
 * Abacus's billing gate refused the turn: a payment it could not confirm
 * (support, never a second purchase) or a subscription that ended (renew).
 * Not the credits card: buying more would not let this account through.
 */
const PaymentCard = ({ lapsed }: { lapsed: boolean }) => {
  const { t } = useTranslation();
  const { runtime, composer } = useChatView();
  return (
    <div
      role="group"
      aria-label={t("chat.error.label")}
      className="mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)]"
      data-slot="error-card"
      data-variant="payment-required"
      data-cause={lapsed ? "lapsed" : "unconfirmed"}
    >
      <GroupCard
        title={t(
          lapsed ? "paymentRequired.lapsedTitle" : "outcome.payment.title"
        )}
      >
        <p className="text-muted-foreground p-3 text-sm">
          {t(lapsed ? "paymentRequired.lapsedBody" : "outcome.payment.body")}
        </p>
        <div className="flex flex-wrap gap-2 p-3">
          <Button
            size="sm"
            data-action={lapsed ? "renew" : "open-billing"}
            onClick={() =>
              void (lapsed
                ? runtime.host.openUpgrade("payment_lapsed")
                : runtime.host.openExternal(ABACUS_BILLING_URL))
            }
          >
            {t(lapsed ? "paymentRequired.renew" : "outcome.payment.billing")}
          </Button>
          {composer.model != null && composer.readOnly == null && (
            <Button
              size="sm"
              variant="secondary"
              data-action="switch-model"
              onClick={(event) => openModelPicker(event.currentTarget)}
            >
              {t("chat.error.switchModel")}
            </Button>
          )}
        </div>
      </GroupCard>
    </div>
  );
};

/**
 * Abacus holds the account's free credits until it verifies a phone: the
 * verify page in the browser is the one way on. The card watches the account
 * and, once the platform says the credits are unlocked, turns in place into
 * the unlock with Send again (the same retry as Retry).
 */
const VerifyPhoneCard = ({
  action,
  onSendAgain,
}: {
  action: ErrorAction;
  /** Offered when Retry would be: the latest outcome, a thread that can reply. */
  onSendAgain?: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const { runtime } = useChatView();
  const account = useAccount();
  const unlocked = freeCreditsUnlocked(account.data);
  useFreeCreditsVerifySurface(!unlocked);
  const granted = account.data?.credits_granted;
  const credits =
    action.credits ??
    (granted != null && granted > 0
      ? new Intl.NumberFormat(i18n.language).format(granted)
      : null);
  if (unlocked)
    return (
      <div
        role="group"
        aria-label={t("chat.error.label")}
        className="mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)]"
        data-slot="error-card"
        data-variant="verify-phone"
        data-state="unlocked"
      >
        <GroupCard>
          {/* GroupCard's own title, with the check after it. */}
          <h2 className="phone:px-4 phone:text-[15px] flex items-center gap-1.5 px-3 py-3 text-[13px] font-semibold">
            {credits != null
              ? t("outcome.verifyPhone.unlockedTitle", { credits })
              : t("outcome.verifyPhone.unlockedTitleNoCount")}
            <CheckCircle2
              aria-hidden
              className="text-primary size-4 shrink-0"
            />
          </h2>
          <p className="text-muted-foreground p-3 text-sm">
            {t("outcome.verifyPhone.unlockedBody")}
          </p>
          {onSendAgain != null && (
            <div className="flex flex-wrap gap-2 p-3">
              <Button size="sm" data-action="send-again" onClick={onSendAgain}>
                {t("outcome.verifyPhone.sendAgain")}
              </Button>
            </div>
          )}
        </GroupCard>
      </div>
    );
  return (
    <div
      role="group"
      aria-label={t("chat.error.label")}
      className="mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)]"
      data-slot="error-card"
      data-variant="verify-phone"
      data-state="held"
    >
      <GroupCard
        title={
          action.credits != null
            ? t("outcome.verifyPhone.title", { credits: action.credits })
            : t("outcome.verifyPhone.titleNoCount")
        }
      >
        <p className="text-muted-foreground p-3 text-sm">
          {t("outcome.verifyPhone.body")}
        </p>
        {/* The agent always names the page (the server's, else the default one). */}
        {action.link != null && (
          <div className="flex flex-wrap gap-2 p-3">
            <Button
              size="sm"
              data-action="verify-phone"
              onClick={() => {
                startFreeCreditsWatch();
                void runtime.host.openExternal(action.link!);
              }}
            >
              {t("outcome.verifyPhone.cta")}
            </Button>
          </div>
        )}
      </GroupCard>
    </div>
  );
};

/** What each cut-off card's person chose, by run: the card shrinks to it. */
const cutOffResolutions = new Store<Record<string, CutOffResolution>>({});
const resolveCutOff = (runId: string, resolution: CutOffResolution): void =>
  cutOffResolutions.setState((state) => ({ ...state, [runId]: resolution }));
/** Cut-off cards already counted as shown, so a re-render is not another. */
const cutOffCounted = new Set<string>();

type CutOffStep =
  | "cutoff_card_shown"
  | "cutoff_continue"
  | "cutoff_switch_routellm"
  | "cutoff_upgrade"
  | "cutoff_upgraded"
  | "cutoff_verify";

/**
 * The ways on from a card in this chat. Plan (a free account's Upgrade), Top
 * up and the next plan: the link opens at click time and the dialog waits for
 * the plan or the credits. Upgrade (Basic's way on): the upgrade dialog.
 * Each sends the waiting message (`resume`) once paid.
 */
const useCreditsCheckout = (
  runId: string,
  resume: (model?: string) => Promise<unknown>
) => {
  const { session, runtime } = useChatView();
  const start = (open: () => Promise<void>) =>
    startCreditsCheckout(open, {
      key: `paid-credits:${runId}:${Date.now()}`,
      threadId: session.threadId,
      pendingText: lastUserText(session.hostStore.state.messages),
      resume,
    });
  return {
    plan: () => start(() => runtime.host.openUpgrade("chat_credits")),
    topUp: () =>
      start(() =>
        runtime.host.openTopUp != null
          ? runtime.host.openTopUp()
          : runtime.host.openExternal(ABACUS_BUY_CREDITS_URL)
      ),
    nextPlan: () =>
      start(() =>
        runtime.host.openNextPlan != null
          ? runtime.host.openNextPlan()
          : runtime.host.openExternal(ABACUS_BILLING_URL)
      ),
    upgrade: () =>
      requestUpgradeDialog(
        {
          kind: "credits",
          key: `paid-upgrade:${runId}:${Date.now()}`,
          threadId: session.threadId,
          pendingText: lastUserText(session.hostStore.state.messages),
          resume,
        },
        true
      ),
  };
};

/**
 * Google cut the reply off on the model the user picked (turn-outcome.ts),
 * even after the agent asked once more: the cut-off card, its ways on, and
 * what each does. Every switch is the person's click, and moves this chat
 * (a bot's chat: its bot) only, never the app's default; a chosen way on
 * picks the cut reply up rather than asking the question again.
 */
const CutOffError = ({
  outcome,
  action,
  canContinue,
  latest,
  tier,
}: {
  outcome: RunOutcomeRecord;
  action: ErrorAction;
  /** The session's first cut: Continue on the same model is offered. */
  canContinue: boolean;
  latest: boolean;
  tier: NonNullable<ErrorCardProps["tier"]>;
}) => {
  const { t } = useTranslation();
  const { session, composer, runtime } = useChatView();
  const { transport } = useAppContext();
  const updatePrefs = useUpdatePrefs();
  const account = useAccount();
  const resume = useUpgradeResume();
  const resolved = useStore(
    cutOffResolutions,
    (state) => state[outcome.runId] ?? null
  );
  const paid = tier === "paid" || tier === "basic";
  // Held credits read as credits to the agent; only the account knows.
  const held =
    action.cause !== "signed-out" &&
    freeCreditsHeld(account.data) &&
    !freeCreditsUnlocked(account.data);
  const state: CutOffState = held
    ? "held"
    : action.cause === "credits" || action.cause === "out"
      ? action.cause
      : "signed-out";
  useFreeCreditsVerifySurface(state === "held");
  const funnel = (step: CutOffStep, detail?: string) =>
    void transport.client.system
      .funnelStep({ step, ...(detail != null && { detail }) })
      .catch(() => undefined);
  const live = (outcome as RunOutcomeRecord & { live?: boolean }).live === true;
  // Counted once per card, as it arrives (a reopened chat's card is
  // history), once the account's plan is read so the state is the real one.
  const known = tier !== "unknown" || state === "signed-out";
  const announce = useEffectEvent(() => {
    if (!live || !known || cutOffCounted.has(outcome.runId)) return;
    cutOffCounted.add(outcome.runId);
    funnel(
      "cutoff_card_shown",
      `${paid && state !== "signed-out" ? "paid" : state.replace("-", "")}${canContinue ? "" : "_again"}`
    );
  });
  useEffect(() => announce(), [live, known, outcome.runId]);
  const canReply = latest && composer.readOnly == null && resolved == null;
  const mode = composer.fixedMode ? { mode: composer.fixedMode } : {};
  // The cut reply is picked up where it stopped, on the chat's model now.
  const goOn = (model?: string) =>
    session.retry(
      { intent: "continue", ...(model != null && { model }), ...mode },
      t("workspace.retryMessage")
    );
  const label = action.label ?? action.model ?? "";
  // Credits or a plan bought: the cut reply goes on where it stopped.
  const paidCheckout = useCreditsCheckout(outcome.runId, async () => {
    funnel("cutoff_upgraded");
    resolveCutOff(outcome.runId, "upgraded");
    return goOn();
  });
  return (
    <div
      role="group"
      aria-label={t("chat.error.label")}
      className="mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)]"
      data-slot="error-card"
      data-variant="cut-off"
    >
      <CutOffCard
        host={runtime.host}
        state={state}
        paid={paid}
        streamed={action.streamed === true}
        label={label}
        resolved={resolved}
        {...(canReply && {
          onSwitch: () => {
            funnel("cutoff_switch_routellm");
            void (async () => {
              const moved =
                (await composer.onSwitchThisChat?.(OPENLLM_ID)) ?? "chat";
              resolveCutOff(
                outcome.runId,
                moved === "bot" ? "switched-bot" : "switched-chat"
              );
              // On RouteLLM now: the composer's own RouteLLM notice is done.
              void updatePrefs({
                dismissals: { routeLlmSwitched: true },
              }).catch(() => undefined);
              await goOn(OPENLLM_ID);
            })().catch(() => {});
          },
          ...(canContinue && {
            onContinue: () => {
              funnel("cutoff_continue");
              resolveCutOff(outcome.runId, "continued");
              void goOn().catch(() => {});
            },
          }),
          onVerify: () => {
            funnel("cutoff_verify");
            startFreeCreditsWatch();
            void runtime.host.openExternal(ABACUS_VERIFY_PHONE_URL);
          },
          onTopUp: () => {
            funnel("cutoff_upgrade", "topup");
            paidCheckout.topUp();
          },
          onNextPlan: () => {
            funnel("cutoff_upgrade", "next_plan");
            paidCheckout.nextPlan();
          },
          // The plan's dialog, with its whole pitch and price; once the plan
          // is active the turn goes on on an Abacus model, in this chat only.
          onUpgrade: () => {
            funnel("cutoff_upgrade");
            // A paid plan's Upgrade (Basic's): the credits dialog for its next plan.
            if (paid) {
              paidCheckout.upgrade();
              return;
            }
            requestUpgradeDialog(
              {
                kind: "own-key",
                key: `cut-off:${outcome.runId}:${Date.now()}`,
                threadId: session.threadId,
                pendingText: lastUserText(session.hostStore.state.messages),
                ownKey: {
                  provider: action.provider ?? "gemini",
                  cause: "cutoff",
                },
                resume: async (model?: string) => {
                  funnel("cutoff_upgraded");
                  resolveCutOff(outcome.runId, "upgraded");
                  if (model == null) return resume();
                  await composer.onSwitchThisChat?.(model).catch(() => {});
                  return goOn(model);
                },
              },
              true
            );
          },
        })}
        {...(canReply &&
          composer.model != null && {
            onPickModel: openModelPicker,
          })}
      />
    </div>
  );
};

/** What the turn a wall cut off handed over, up to the outcome's anchor. */
const readyBefore = (
  messages: readonly UIMessage[],
  afterMessageId: string | null
) => {
  if (afterMessageId == null) return [];
  const at = messages.findIndex((message) => message.id === afterMessageId);
  return latestPresented(at < 0 ? messages : messages.slice(0, at + 1));
};

export interface ErrorCardProps {
  outcome: RunOutcomeRecord;
  /** The latest terminal while the thread is idle (Retry is offered then). */
  latest: boolean;
  tier?: "free" | "basic" | "paid" | "unknown";
}

export const ErrorCard = ({
  outcome,
  latest,
  tier: providedTier,
}: ErrorCardProps) => {
  const { t } = useTranslation();
  const { session, composer, runtime, skin, slots } = useChatView();
  const { transport } = useAppContext();
  const resume = useUpgradeResume();
  const switchToAbacus = useSwitchToAbacus();
  const [accountTier, setAccountTier] =
    useState<NonNullable<ErrorCardProps["tier"]>>("unknown");
  const [tierRead, setTierRead] = useState(false);
  useEffect(() => {
    if (providedTier != null) return;
    let live = true;
    runtime.host
      .accountTier()
      .then((value) => {
        if (live) setAccountTier(value);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setTierRead(true);
      });
    return () => {
      live = false;
    };
  }, [providedTier, runtime]);
  const tier = providedTier ?? accountTier;
  const paying = tier === "paid" || tier === "basic";
  const paidCheckout = useCreditsCheckout(outcome.runId, resume);
  const error = outcome.error ?? { message: "" };
  const actions = ((error as { actions?: ErrorAction[] }).actions ??
    []) as ErrorAction[];
  const detail = (error as { detail?: string }).detail;
  const upgrade = wantsUpgradeCard(actions, paying);
  // A paid plan at the wall: its offer picks the card. Basic's (the next plan
  // alone) is the free plan's one line, its dialog carrying the pitch.
  const paidAtWall =
    upgrade &&
    paying &&
    actions.some((action) => action.type === "upgrade-abacus");
  const [paidWallOffer, setPaidWallOffer] = useState<
    PaidCreditsOffer | null | undefined
  >(undefined);
  useEffect(() => {
    if (!paidAtWall) return;
    let live = true;
    void Promise.resolve(runtime.host.billingPlan?.() ?? null)
      .then((billing) => {
        if (live) setPaidWallOffer(paidCreditsOffer(billing));
      })
      .catch(() => {
        if (live) setPaidWallOffer(null);
      });
    return () => {
      live = false;
    };
  }, [paidAtWall, runtime]);
  const cause = (error as { cause?: string }).cause;
  // A model the plan does not include: main has locked it, so the picker
  // re-reads without it.
  const unavailable = modelUnavailable(actions);
  const refusedModel =
    unavailable?.cause === "plan" ? unavailable.model : undefined;
  useEffect(() => {
    if (refusedModel != null)
      void runtime.host.refreshModels?.().catch(() => {});
  }, [refusedModel, runtime]);
  const crashed = error.code === "agent_exit" || error.code === "agent_crashed";
  const canReply = composer.readOnly == null;
  const retry = () =>
    void session
      .retry(
        composer.fixedMode ? { mode: composer.fixedMode } : undefined,
        t("workspace.retryMessage")
      )
      .catch(() => {});
  // The app closed under the run: an interruption, not the agent's failure.
  // What it did up to then was saved as it went; Continue picks it up there.
  if (error.code === "app_closed")
    return (
      <div
        className="text-muted-foreground flex min-h-7 items-center gap-2 text-xs"
        data-slot="run-marker"
        data-kind="interrupted"
      >
        <CircleStop aria-hidden className="size-3.5 shrink-0" />
        {t("status.appClosed")}
        {latest && canReply ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void session
                .retry(
                  {
                    intent: "continue",
                    ...(composer.fixedMode ? { mode: composer.fixedMode } : {}),
                  },
                  t("workspace.retryMessage")
                )
                .catch(() => {})
            }
          >
            {t("status.continue")}
          </Button>
        ) : null}
      </div>
    );
  const verify = actions.find((action) => action.type === "verify-phone");
  if (verify != null)
    return (
      <VerifyPhoneCard
        action={verify}
        {...(latest && canReply ? { onSendAgain: retry } : {})}
      />
    );
  const payment = actions.find((action) => action.type === "payment-required");
  if (payment != null)
    return <PaymentCard lapsed={payment.cause === "lapsed"} />;
  const cutOff = actions.find((action) => action.type === "cut-off");
  if (cutOff != null)
    return (
      <CutOffError
        outcome={outcome}
        action={cutOff}
        canContinue={actions.some((action) => action.type === "continue-same")}
        latest={latest}
        tier={tier}
      />
    );
  // A provider that seems silent while the computer is offline is the
  // connection's fault, not the key's: the plain error says so.
  const ownKey = ownKeyFailure(actions);
  if (
    ownKey != null &&
    !(ownKey.cause === "network" && globalThis.navigator?.onLine === false)
  )
    return (
      <OwnKeyCard
        failure={ownKey}
        tier={tier}
        runId={outcome.runId}
        credits={actions.some((action) => action.type === "switch-to-abacus")}
        latest={latest}
      />
    );
  if (unavailable != null)
    return (
      <div
        role="group"
        aria-label={t("chat.error.label")}
        className="mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)]"
        data-slot="error-card"
        data-variant="model-unavailable"
      >
        <ModelUnavailableCard
          host={runtime.host}
          kind={
            unavailable.cause === "plan" || unavailable.cause === "down"
              ? unavailable.cause
              : "retired"
          }
          label={unavailable.label ?? unavailable.model ?? ""}
          creditsOut={actions.some(
            (action) => action.type === "upgrade-abacus"
          )}
          paid={paying}
          {...(latest &&
            canReply &&
            actions.some((action) => action.type === "switch-to-abacus") && {
              // The kept message goes again on RouteLLM - Open, by choice.
              onSwitch: () =>
                void session
                  .retry(
                    {
                      model: OPENLLM_ID,
                      ...(composer.fixedMode
                        ? { mode: composer.fixedMode }
                        : {}),
                    },
                    t("workspace.retryMessage")
                  )
                  .catch(() => {}),
            })}
          {...(composer.model != null &&
            canReply && {
              onPickModel: openModelPicker,
            })}
          {...(canReply &&
            paying && {
              onTopUp: paidCheckout.topUp,
              onNextPlan: paidCheckout.nextPlan,
            })}
          {...(canReply && {
            onUpgrade: () =>
              requestUpgradeDialog(
                {
                  kind: "credits",
                  key: `model-unavailable:${outcome.runId}:${Date.now()}`,
                  threadId: session.threadId,
                  pendingText: lastUserText(session.hostStore.state.messages),
                  resume,
                },
                true
              ),
          })}
        />
      </div>
    );
  if (upgrade) {
    const ready =
      slots.renderDeliverables == null
        ? []
        : readyBefore(session.hostStore.state.messages, outcome.afterMessageId);
    // The turn on the free pool goes on there once the user says so.
    const resumeOnFreePool = async () => {
      await runtime.host.chooseFreeLane?.();
      await composer.onResumeOnFreePool?.();
      await session.retry(
        {
          model: OPENLLM_ID,
          ...(composer.fixedMode ? { mode: composer.fixedMode } : {}),
        },
        t("workspace.retryMessage")
      );
    };
    const atWall = actions.some((action) => action.type === "upgrade-abacus");
    const continueFree = actions.find(
      (action) => action.type === "continue-free"
    );
    // See plans: the upgrade dialog, asked for by the person.
    const seePlans = () =>
      requestUpgradeDialog(
        {
          kind: "credits",
          key: `credit-wall:${outcome.runId}:${Date.now()}`,
          threadId: session.threadId,
          pendingText: lastUserText(session.hostStore.state.messages),
          ...(creditsExpired(actions) ? { expired: true } : {}),
          ...(canReply && { resume }),
        },
        true
      );
    // Upgrade goes to checkout; the dialog waits for the plan and, where the
    // person can reply here, sends the stopped message again. A routine run
    // or a channel chat has none to send: checkout alone.
    const upgradeNow = () => {
      if (canReply)
        return paying ? paidCheckout.nextPlan() : paidCheckout.plan();
      if (paying) return void runtime.host.openNextPlan?.().catch(() => {});
      startPlanCheckout(transport.client, "credit_wall");
    };
    // The free ways on beside the plan: a $0 model by name, the key to fix.
    const alternatives = (size?: "sm") =>
      canReply ? (
        <>
          {composer.model &&
            actions
              .filter(
                (action) => action.type === "switch-model" && action.model
              )
              .map((action) => (
                <Button
                  key={action.model}
                  {...(size != null ? { size } : {})}
                  variant="secondary"
                  onClick={() => composer.model?.onChange(action.model!)}
                >
                  {action.ownKey === true
                    ? t("outcome.wall.continueOwnKey", {
                        model: action.label ?? action.model,
                      })
                    : t("workspace.premiumUpgrade.continueOn", {
                        model: action.label ?? action.model,
                      })}
                </Button>
              ))}
          {actions.some((action) => action.type === "fix-key") && (
            <Button
              nativeButton={false}
              {...(size != null ? { size } : {})}
              variant="secondary"
              data-action="fix-key"
              render={<AppLink to="/settings/models" />}
            >
              {t("outcome.action.fixKey")}
            </Button>
          )}
        </>
      ) : undefined;
    // Until the plan and a paid plan's offer are read, no card: they pick which
    // one, and someone who paid must never first read the free plan's words.
    if (atWall && providedTier == null && !tierRead) return null;
    if (paidAtWall && paidWallOffer === undefined) return null;
    const task = taskText(session.hostStore.state.messages);
    // A wall further up the chat is history: its title alone, the offer is the latest one's.
    if (atWall && !latest)
      return (
        <div
          role="group"
          aria-label={t("chat.error.label")}
          className="bg-card mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)] rounded-xl border px-3 py-2.5 text-sm font-medium"
          data-slot="error-card"
          data-variant="upgrade-history"
        >
          {creditWallTitle(
            t,
            { ...(task != null && { task }), expired: creditsExpired(actions) },
            paying
          )}
        </div>
      );
    return (
      <div
        role="group"
        aria-label={t("chat.error.label")}
        className="mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)]"
        data-slot="error-card"
        data-variant="upgrade"
      >
        <CreditsCard
          host={runtime.host}
          tier={tier}
          scope={exhaustedScope(actions)}
          {...(creditsExpired(actions) && {
            title: t("creditsCard.expiredTitle"),
          })}
          {...(ready.length > 0 && {
            ready: slots.renderDeliverables?.(ready),
          })}
          {...(atWall && {
            wall: {
              providers: continueFree?.providers ?? [],
              expired: creditsExpired(actions),
              ...(task != null && { task }),
              resumes: canReply,
              ...(continueFree != null &&
                latest &&
                canReply && { onContinueFree: resumeOnFreePool }),
              onUpgrade: upgradeNow,
              onSeePlans: seePlans,
              ...(canReply &&
                paying && {
                  onTopUp: paidCheckout.topUp,
                  onNextPlan: paidCheckout.nextPlan,
                }),
            },
          })}
          alternatives={alternatives()}
          // Connecting a free source from the card is choosing the free lane.
          onResume={latest && canReply ? resumeOnFreePool : undefined}
        />
      </div>
    );
  }
  const connection = error.code === "network_unreachable";
  // RouteLLM - Open is the switch; the picker beside it is the other way on.
  const switchOffered = actions.some(
    (action) => action.type === "switch-to-abacus"
  );
  const buttons = actions.flatMap((action, index) => {
    switch (action.type) {
      case "retry":
        return latest && canReply
          ? [
              <Button key={index} variant="secondary" onClick={retry}>
                {t(connection ? "outcome.action.tryAgain" : "chat.error.retry")}
              </Button>,
            ]
          : [];
      case "new-chat":
        return composer.onNewChat != null && canReply
          ? [
              <Button
                key={index}
                variant="secondary"
                data-action="new-chat"
                onClick={composer.onNewChat}
              >
                {t("outcome.action.newChat")}
              </Button>,
            ]
          : [];
      case "switch-to-abacus":
        return latest && canReply
          ? [
              <Button
                key={index}
                variant="secondary"
                data-action="switch-to-abacus"
                onClick={switchToAbacus}
              >
                {t("outcome.unavailable.switch")}
              </Button>,
            ]
          : [];
      case "fix-key":
        return [
          <Button
            key={index}
            nativeButton={false}
            variant="secondary"
            data-action="fix-key"
            render={<AppLink to="/settings/models" />}
          >
            {t("outcome.action.fixKey")}
          </Button>,
        ];
      case "switch-model":
        return action.model != null && composer.model != null && canReply
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
          : composer.model != null && canReply
            ? [
                <Button
                  key={index}
                  variant="secondary"
                  data-action="switch-model"
                  onClick={(event) => openModelPicker(event.currentTarget)}
                >
                  {t(
                    switchOffered
                      ? "outcome.unavailable.pickModel"
                      : "chat.error.switchModel"
                  )}
                </Button>,
              ]
            : [];
      default:
        return action.link != null
          ? [
              <Button
                key={index}
                variant="secondary"
                onClick={(event) => {
                  if (action.type === "retry")
                    void session.retry().catch(() => {});
                  else if (action.type === "switch-model") {
                    if (action.model != null)
                      composer.model?.onChange(action.model);
                    else openModelPicker(event.currentTarget);
                  } else if (action.type === "upgrade-abacus")
                    void runtime.host.openUpgrade("chat_notice");
                  else if (action.link != null)
                    void runtime.host.openExternal(action.link);
                }}
              >
                {action.label ?? t("chat.error.open")}
              </Button>,
            ]
          : [];
    }
  });
  if (
    (crashed || skin === "bot") &&
    latest &&
    canReply &&
    !actions.some((action) => action.type === "retry")
  )
    buttons.push(
      <Button key="retry" variant="secondary" onClick={retry}>
        {t("chat.error.retry")}
      </Button>
    );
  return (
    <div
      role="group"
      aria-label={t("chat.error.label")}
      className="bg-destructive/10 dark:bg-destructive/15 mx-auto flex w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)] flex-col gap-2 rounded-2xl p-4 text-sm"
      data-slot="error-card"
    >
      <div className="flex items-start gap-2">
        <XCircle
          aria-hidden
          className="text-destructive mt-0.5 size-4 shrink-0"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium" data-cause={cause}>
            {crashed
              ? t("chat.error.crashed")
              : connection
                ? t("outcome.connection.title")
                : cause === "disk_full"
                  ? diskFullLine(actions, t)
                  : cause != null && OUTCOME_CAUSES.has(cause)
                    ? t(`outcome.cause.${cause}`, {
                        provider: providerDisplayName(
                          actions.find((action) => action.provider != null)
                            ?.provider ?? ""
                        ),
                      })
                    : providerMessage(error.message) ||
                      t("errors.genericDescription")}
          </div>
          {connection ? (
            <p className="text-muted-foreground text-xs">
              {t("outcome.connection.body")}
            </p>
          ) : detail != null && detail !== "" ? (
            <p className="text-muted-foreground text-xs break-words">
              {detail}
            </p>
          ) : null}
        </div>
      </div>
      {connection && detail != null && detail !== "" ? (
        <details className="ps-6 text-xs" data-slot="connection-details">
          <summary className="cursor-pointer">
            {t("outcome.action.viewDetails")}
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto break-all whitespace-pre-wrap">
            {detail}
          </pre>
        </details>
      ) : (
        providerMessage(error.message) !== error.message && (
          <details className="ps-6 text-xs">
            <summary className="cursor-pointer">{t("phase5.details")}</summary>
            <pre className="mt-2 max-h-40 overflow-auto break-all whitespace-pre-wrap">
              {error.message}
            </pre>
          </details>
        )
      )}
      {buttons.length > 0 ? (
        <div className="flex flex-wrap gap-2 ps-6">{buttons}</div>
      ) : null}
      {canReply && actions.some((action) => action.type === "plan-offer") && (
        <div className="ps-6">
          <PlanOffer
            host={runtime.host}
            paid={paying}
            onUpgrade={() =>
              requestUpgradeDialog(
                {
                  kind: "credits",
                  key: `plan-offer:${outcome.runId}:${Date.now()}`,
                  threadId: session.threadId,
                  pendingText: lastUserText(session.hostStore.state.messages),
                  resume,
                },
                true
              )
            }
            {...(paying && {
              onTopUp: paidCheckout.topUp,
              onNextPlan: paidCheckout.nextPlan,
            })}
          />
        </div>
      )}
    </div>
  );
};

const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

/** The full-disk card's line, with what is left when the agent measured it. */
const diskFullLine = (
  actions: ErrorAction[],
  t: (key: string, values?: Record<string, string>) => string
): string => {
  const free = actions.find((action) => action.type === "retry")?.bytesFree;
  return free != null
    ? t("outcome.cause.disk_full", { free: formatBytes(free) })
    : t("outcome.cause.disk_fullUnmeasured");
};

/** The action on a job that finished with no turn running. */
const BACKGROUND_JOB_ACTION = "background-job";

/** A command as long as a one-line notice can carry. */
const BACKGROUND_COMMAND_CHARS = 100;

const backgroundJobLine = (
  action: ErrorAction,
  t: (key: string, values?: Record<string, string>) => string
): string => {
  const whole = action.label ?? "";
  const command =
    whole.length > BACKGROUND_COMMAND_CHARS
      ? `${whole.slice(0, BACKGROUND_COMMAND_CHARS)}…`
      : whole;
  if (action.cause === "timed-out")
    return t("chat.notice.backgroundTimedOut", { command });
  return action.cause === "failed"
    ? t("chat.notice.backgroundFailed", { command })
    : t("chat.notice.backgroundFinished", { command });
};

/** The spend governor closed the run out at a limit; see spendLimitLine. */
const SPEND_LIMIT_ACTION = "spend-limit";
/** The history was summarized to keep the chat fast and cheap. */
const COMPACTED_ACTION = "compacted";

const SPEND_LIMIT_KEYS = {
  budget: "chat.notice.spendBudget",
  calls: "chat.notice.spendCalls",
  time: "chat.notice.spendTime",
} as const;

/** The close-out line in the app's words: which limit, and its size. */
const spendLimitLine = (
  action: ErrorAction,
  t: (key: string, values?: Record<string, unknown>) => string
): string => {
  const key =
    SPEND_LIMIT_KEYS[action.cause as keyof typeof SPEND_LIMIT_KEYS] ??
    SPEND_LIMIT_KEYS.calls;
  return t(key, { count: action.amount ?? 0 });
};

/**
 * The low-credit notice's way on, as the milestone card offers it
 * (milestoneOffer): Basic's next plan alone opens as the free plan's upgrade
 * does; any other paid plan its top-up and next plan. None for a plan with
 * nothing to offer, or one not read yet.
 */
const CreditsLowButtons = () => {
  const { t } = useTranslation();
  const { runtime } = useChatView();
  const plan = creditMilestonePlan(useAccount().data);
  const [billing, setBilling] = useState<BillingPlan | null | undefined>(
    undefined
  );
  useEffect(() => {
    if (plan == null) return;
    let live = true;
    void Promise.resolve(runtime.host.billingPlan?.() ?? null)
      .then((read) => {
        if (live) setBilling(read);
      })
      .catch(() => {
        if (live) setBilling(null);
      });
    return () => {
      live = false;
    };
  }, [plan, runtime]);
  if (plan == null || billing === undefined) return null;
  const offer = milestoneOffer(plan, billing);
  if (offer.plan === "paid" && offer.offer == null) return null;
  if (offer.plan === "free" || paidUpgradeOnly(offer.offer))
    return (
      <Button
        variant="ghost"
        size="sm"
        data-action="upgrade"
        onClick={() => void runtime.host.openUpgrade("low_credits")}
      >
        {t("creditsCard.cta")}
      </Button>
    );
  return (
    <PaidOfferButtons
      offer={offer.offer!}
      className="shrink-0"
      {...(runtime.host.openTopUp != null && {
        onTopUp: () => void runtime.host.openTopUp?.(),
      })}
      {...(runtime.host.openNextPlan != null && {
        onNextPlan: () => void runtime.host.openNextPlan?.(),
      })}
    />
  );
};

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
  const { runtime, session, composer, skin } = useChatView();
  const severity = (
    notice.name === "agent.error"
      ? "error"
      : notice.name === "abacus.notice"
        ? "warning"
        : String(notice.value.severity ?? "info")
  ) as keyof typeof SEVERITY_ICON;
  const Icon = SEVERITY_ICON[severity] ?? Info;
  const actions = (notice.value.actions as ErrorAction[] | undefined) ?? [];
  // Main's own notice about the thread (a v1 history too large to read, a
  // thread file a newer build wrote, or a save the full disk refused).
  const tooLarge =
    notice.name === "abacus.notice" && notice.value.kind === "too-large";
  const foreign =
    notice.name === "abacus.notice" && notice.value.kind === "foreign";
  const unsaved =
    notice.name === "abacus.notice" && notice.value.kind === "unsaved";
  const historyPath =
    typeof notice.value.path === "string" ? notice.value.path : null;
  // The agent moved the message to RouteLLM - Open: the line in the app's words.
  const moved = actions.find(
    (action) => action.type === MOVED_TO_ABACUS_ACTION
  );
  // A job that finished with no turn running: the line in the app's words.
  const backgroundJob = actions.find(
    (action) => action.type === BACKGROUND_JOB_ACTION
  );
  const creditsLowAction = actions.find(
    (action) => action.type === CREDITS_LOW_NOTICE_ACTION
  );
  const creditsLow = creditsLowAction != null;
  // A limit the spend governor closed the run out at, and the history summary.
  const spendLimit = actions.find(
    (action) => action.type === SPEND_LIMIT_ACTION
  );
  const compacted = actions.some((action) => action.type === COMPACTED_ACTION);
  const message = creditsLow
    ? t("chat.notice.creditsLow", { count: creditsLowAction.amount ?? 0 })
    : spendLimit != null
      ? spendLimitLine(spendLimit, t)
      : compacted
        ? t("chat.notice.compacted")
        : tooLarge
          ? t("chat.notice.historyTooLarge", {
              size: formatBytes(Number(notice.value.size ?? 0)),
              limit: formatBytes(Number(notice.value.limit ?? 0)),
            })
          : foreign
            ? t("chat.notice.historyForeign")
            : unsaved
              ? t("chat.notice.unsaved")
              : moved != null
                ? ownKeyMovedLine(moved, t)
                : backgroundJob != null
                  ? backgroundJobLine(backgroundJob, t)
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
      {creditsLow ? <CreditsLowButtons /> : null}
      {IS_ELECTRON && tooLarge && historyPath != null ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void runtime.host.showItemInFolder(historyPath)}
        >
          {t("chat.notice.showInFolder")}
        </Button>
      ) : null}
      {skin === "bot" &&
        severity === "error" &&
        composer.readOnly == null &&
        !composer.turnBusy &&
        !actions.some((action) => action.type === "retry") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void session
                .retry(undefined, t("workspace.retryMessage"))
                .catch(() => {})
            }
          >
            {t("chat.error.retry")}
          </Button>
        )}
      {actions
        .filter((action) =>
          action.type === "retry"
            ? composer.readOnly == null && !composer.turnBusy
            : action.type === "switch-model"
              ? composer.readOnly == null && composer.model != null
              : action.link != null
        )
        .map((action, index) => (
          <Button
            key={index}
            variant="ghost"
            size="sm"
            onClick={(event) => {
              if (action.type === "retry")
                void session
                  .retry(undefined, t("workspace.retryMessage"))
                  .catch(() => {});
              else if (action.type === "switch-model") {
                if (action.model != null)
                  composer.model?.onChange(action.model);
                else openModelPicker(event.currentTarget);
              } else if (action.type === "upgrade-abacus")
                void runtime.host.openUpgrade("chat_notice");
              else if (action.link != null)
                void runtime.host.openExternal(action.link);
            }}
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
