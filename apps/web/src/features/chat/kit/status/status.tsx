/**
 * Status components (spec 02 §5.6): the sessions busy line, the bots typing
 * bubble, run outcome markers, the error card with its action table (and
 * the upgrade variant), and notices.
 */
import { OPENLLM_ID } from "@abacus-ai/contract/models";
import { providerDisplayName } from "@abacus-ai/contract/settings";
import type { UIMessage } from "@tanstack/ai-client";
import { Store, useStore } from "@tanstack/react-store";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { CreditsCard } from "#renderer/components/credits-card";
import {
  CutOffCard,
  type CutOffResolution,
  type CutOffState,
  ModelUnavailableCard,
} from "#renderer/components/credits-card/model-unavailable";
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
  ownKeyFailure,
  ownKeyHeadlineKey,
  type OwnKeyFailure,
} from "#renderer/lib/own-key-unavailable";
import { IS_ELECTRON } from "#renderer/lib/platform";
import {
  lastUserText,
  requestUpgradeDialog,
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
import { toolTitle } from "../tools/tool-line";
import { creditsExpired, useUpgradeResume } from "../upgrade-triggers";

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
        onClick={() => void runtime.host.openUpgrade()}
      >
        {t("outcome.freeChipUpgrade")}
      </Button>
    </div>
  );
};

export const RunMarker = ({ outcome }: { outcome: RunOutcomeRecord }) => {
  const marker = <RunMarkerLine outcome={outcome} />;
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

/**
 * A turn on the person's own key that ran out of credit, hit its rate limit
 * or found its provider silent, in place of the provider's error. A free
 * account was offered the upgrade dialog, which this card can bring back; a
 * paid or unread one already has the top models in AbacusAI Agent on the web.
 */
const OwnKeyCard = ({
  failure,
  tier,
  runId,
}: {
  failure: OwnKeyFailure;
  tier: NonNullable<ErrorCardProps["tier"]>;
  runId: string;
}) => {
  const { t } = useTranslation();
  const { session, composer, runtime } = useChatView();
  const resume = useUpgradeResume();
  const free = tier === "free";
  return (
    <div
      role="group"
      aria-label={t("chat.error.label")}
      className="mx-auto w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)]"
      data-slot="error-card"
      data-variant="own-key"
      data-cause={failure.cause}
    >
      <GroupCard
        title={t(ownKeyHeadlineKey(failure.cause), {
          provider: providerDisplayName(failure.provider),
        })}
      >
        <p className="text-muted-foreground p-3 text-sm">
          {t(free ? "ownKey.freeBody" : "ownKey.paidBody")}
        </p>
        <div className="flex flex-col gap-3 p-3">
          {free ? (
            composer.readOnly == null && (
              <Button
                size="sm"
                onClick={() =>
                  requestUpgradeDialog(
                    {
                      kind: "own-key",
                      key: `own-key-card:${runId}:${Date.now()}`,
                      threadId: session.threadId,
                      pendingText: lastUserText(
                        session.hostStore.state.messages
                      ),
                      ownKey: failure,
                      resume,
                    },
                    true
                  )
                }
              >
                {t("creditsCard.cta")}
              </Button>
            )
          ) : (
            <Button
              size="sm"
              data-action="open-abacus-agent"
              onClick={() => void runtime.host.openExternal(ABACUS_AGENT_URL)}
            >
              {t("ownKey.openAgent")}
            </Button>
          )}
        </div>
      </GroupCard>
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
                ? runtime.host.openUpgrade()
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
              onClick={(event) =>
                event.currentTarget
                  .closest('[data-slot="chat-view"]')
                  ?.querySelector<HTMLButtonElement>(
                    '[data-slot="chat-model-picker"]'
                  )
                  ?.click()
              }
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
            void runtime.host.openExternal(ABACUS_BUY_CREDITS_URL);
          },
          // The plan's dialog, with its whole pitch and price; once the plan
          // is active the turn goes on on an Abacus model, in this chat only.
          onUpgrade: () => {
            funnel("cutoff_upgrade");
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
            onPickModel: (from: HTMLElement) =>
              from
                .closest('[data-slot="chat-view"]')
                ?.querySelector<HTMLButtonElement>(
                  '[data-slot="chat-model-picker"]'
                )
                ?.click(),
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
  const resume = useUpgradeResume();
  const [accountTier, setAccountTier] =
    useState<NonNullable<ErrorCardProps["tier"]>>("unknown");
  useEffect(() => {
    if (providedTier != null) return;
    let live = true;
    runtime.host
      .accountTier()
      .then((value) => {
        if (live) setAccountTier(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [providedTier, runtime]);
  const tier = providedTier ?? accountTier;
  const error = outcome.error ?? { message: "" };
  const actions = ((error as { actions?: ErrorAction[] }).actions ??
    []) as ErrorAction[];
  const detail = (error as { detail?: string }).detail;
  const upgrade = wantsUpgradeCard(
    actions,
    tier === "paid" || tier === "basic"
  );
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
    return <OwnKeyCard failure={ownKey} tier={tier} runId={outcome.runId} />;
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
              onPickModel: (from: HTMLElement) =>
                from
                  .closest('[data-slot="chat-view"]')
                  ?.querySelector<HTMLButtonElement>(
                    '[data-slot="chat-model-picker"]'
                  )
                  ?.click(),
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
    // The upgrade dialog, asked for by the person: its pitch is the plan's whole list.
    const askUpgrade = () =>
      requestUpgradeDialog(
        {
          kind: "credits",
          key: `credit-wall:${outcome.runId}:${Date.now()}`,
          threadId: session.threadId,
          pendingText: lastUserText(session.hostStore.state.messages),
          ...(creditsExpired(actions) ? { expired: true } : {}),
          resume,
        },
        true
      );
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
                  {t("workspace.premiumUpgrade.continueOn", {
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
    // A free account at the Abacus wall: the pitch is the upgrade dialog's
    // (UpgradeTriggers opens it once per stopped run); here, one line and the
    // way back to it, beside the free ways on.
    if (atWall && tier === "free")
      return (
        <div
          role="group"
          aria-label={t("chat.error.label")}
          className="mx-auto flex w-full max-w-[calc(var(--composer-max-w)-var(--spacing)*8)] flex-col gap-3"
          data-slot="error-card"
          data-variant="upgrade-status"
        >
          <div className="bg-card flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 text-sm">
            <span className="me-auto font-medium">
              {t(
                creditsExpired(actions)
                  ? "outcome.wall.expiredTitle"
                  : "outcome.wall.title"
              )}
            </span>
            {canReply && (
              <Button size="sm" data-action="upgrade" onClick={askUpgrade}>
                {t("creditsCard.cta")}
              </Button>
            )}
            {continueFree?.providers != null &&
              continueFree.providers.length > 0 &&
              latest &&
              canReply && (
                <Button
                  size="sm"
                  variant="secondary"
                  data-action="continue-free"
                  onClick={() => void resumeOnFreePool().catch(() => {})}
                >
                  {t("outcome.wall.continueFree")}
                </Button>
              )}
            {alternatives("sm")}
          </div>
          {ready.length > 0 && slots.renderDeliverables?.(ready)}
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
              ...(continueFree != null &&
                latest &&
                canReply && { onContinueFree: resumeOnFreePool }),
              ...(canReply && { onUpgrade: askUpgrade }),
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
                onClick={() =>
                  void (async () => {
                    await composer.onResumeOnFreePool?.();
                    await session.retry(
                      {
                        model: OPENLLM_ID,
                        ...(composer.fixedMode
                          ? { mode: composer.fixedMode }
                          : {}),
                      },
                      t("workspace.retryMessage")
                    );
                  })().catch(() => {})
                }
              >
                {t("outcome.action.switchToAbacus")}
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
                  onClick={(event) =>
                    event.currentTarget
                      .closest('[data-slot="chat-view"]')
                      ?.querySelector<HTMLButtonElement>(
                        '[data-slot="chat-model-picker"]'
                      )
                      ?.click()
                  }
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
                onClick={(event) => {
                  if (action.type === "retry")
                    void session.retry().catch(() => {});
                  else if (action.type === "switch-model") {
                    if (action.model != null)
                      composer.model?.onChange(action.model);
                    else
                      event.currentTarget
                        .closest('[data-slot="chat-view"]')
                        ?.querySelector<HTMLButtonElement>(
                          '[data-slot="chat-model-picker"]'
                        )
                        ?.click();
                  } else if (action.type === "upgrade-abacus")
                    void runtime.host.openUpgrade();
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
  // Main's own notice about the thread (a v1 history too large to read, or
  // a thread file a newer build wrote).
  const tooLarge =
    notice.name === "abacus.notice" && notice.value.kind === "too-large";
  const foreign =
    notice.name === "abacus.notice" && notice.value.kind === "foreign";
  const historyPath =
    typeof notice.value.path === "string" ? notice.value.path : null;
  const message = tooLarge
    ? t("chat.notice.historyTooLarge", {
        size: formatBytes(Number(notice.value.size ?? 0)),
        limit: formatBytes(Number(notice.value.limit ?? 0)),
      })
    : foreign
      ? t("chat.notice.historyForeign")
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
                else
                  event.currentTarget
                    .closest('[data-slot="chat-view"]')
                    ?.querySelector<HTMLButtonElement>(
                      '[data-slot="chat-model-picker"]'
                    )
                    ?.click();
              } else if (action.type === "upgrade-abacus")
                void runtime.host.openUpgrade();
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
