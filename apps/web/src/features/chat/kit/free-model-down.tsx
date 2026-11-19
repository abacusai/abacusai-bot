/**
 * What a free account sees when its turn ended because the free model is
 * overloaded (turn-outcome.ts freeModelOverloaded: the agent's one outcome
 * for the free model busy, silent, "down" when picked by hand, or failing
 * again on the pool's fallback). Honest about why, then the two ways on: the
 * plan's top model finishes the waiting message (the upgrade dialog's
 * checkout, then the same resume as the credit wall's), or the free model
 * again after a short wait.
 *
 * A chat whose first message failed, before anything in it worked, tries the
 * free model once more on its own before any pitch: such a retry almost
 * always answers, and someone who has seen nothing work yet is not sold a
 * plan. If that fails too, the card.
 */
import { type BillingPlan, wallOffer } from "@abacus-ai/contract/billing-plan";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Zap } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { openUpgrade } from "#renderer/lib/upgrade";
import {
  lastUserText,
  requestUpgradeDialog,
} from "#renderer/lib/upgrade-dialog";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useHost, useThreadStore } from "../store/selectors";
import type { RunOutcomeRecord } from "../store/thread-store";
import { useChatView } from "./context";
import { PitchCardFrame } from "./success-pitch";
import {
  isLive,
  useCreditWallTask,
  useUpgradeResume,
} from "./upgrade-triggers";

/** Try free again waits this long: the outage is minutes, not seconds. */
export const FREE_RETRY_WAIT_S = 15;
/** A chat's first message tries the free model again once, after this long. */
export const FIRST_RETRY_WAIT_S = 30;

/** The free model's outage, as the agent marks it on a free account's turn. */
export const freeModelDown = (
  actions: ReadonlyArray<{ type: string; cause?: string }>
): boolean =>
  actions.some(
    (action) => action.type === "free-pool-out" && action.cause === "busy"
  );

/**
 * The thread's first message failed before anything in it worked: no run
 * before this one answered or failed (a run the user stopped does not count).
 */
export const firstMessageFailed = (
  outcomes: readonly Pick<RunOutcomeRecord, "runId" | "kind">[],
  runId: string
): boolean => {
  const at = outcomes.findIndex((outcome) => outcome.runId === runId);
  return (
    at >= 0 &&
    outcomes.slice(0, at).every((outcome) => outcome.kind === "cancelled")
  );
};

/** Counted once per run: the card re-renders, the beacon does not. */
const shownRuns = new Set<string>();

/** Runs whose first-message retry already went: never twice, whatever remounts. */
const autoRetried = new Set<string>();

/** A wait that ends at `at` (epoch ms), `seconds` long. */
interface Wait {
  at: number;
  seconds: number;
}

const waitOf = (seconds: number): Wait => ({
  at: Date.now() + seconds * 1000,
  seconds,
});

/** Whole seconds left on `wait`, ticking; `onDone` once it ends. */
const useSecondsLeft = (
  wait: Wait | null,
  onDone: () => void
): number | null => {
  const deadline = wait?.at ?? null;
  const [now, setNow] = useState(() => Date.now());
  const done = useEffectEvent(onDone);
  useEffect(() => {
    if (deadline == null) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= deadline) {
        clearInterval(timer);
        done();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [deadline]);
  // Before the first tick `now` is older than the wait: never more than its length.
  return wait == null
    ? null
    : Math.min(wait.seconds, Math.max(0, Math.ceil((wait.at - now) / 1000)));
};

export interface FreeModelDownCardProps {
  billing: BillingPlan;
  /** Try free again is counting down: the seconds left. */
  retryIn: number | null;
  onUpgrade(): void;
  onRetry(): void;
}

/**
 * The card: the free model is overloaded; finish this on a top model with
 * the plan (its price and whole list), or try the free model again.
 */
export const FreeModelDownCard = ({
  billing,
  retryIn,
  onUpgrade,
  onRetry,
}: FreeModelDownCardProps) => {
  const { t } = useTranslation();
  const offer = wallOffer(billing);
  if (offer == null) return null;
  return (
    <PitchCardFrame
      slot="free-model-down"
      moment="free_model_down"
      icon={<Zap className="size-4" />}
      title={t("freeModelDown.title")}
      line={t("freeModelDown.line", { plan: offer.planName })}
      lead="models"
      billing={billing}
      cta={t("freeModelDown.upgrade")}
      onUpgrade={onUpgrade}
      secondary={
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          data-action="try-free-again"
          disabled={retryIn != null}
          onClick={onRetry}
        >
          {retryIn != null ? (
            <>
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              {t("freeModelDown.retrying", { seconds: retryIn })}
            </>
          ) : (
            t("freeModelDown.retry")
          )}
        </Button>
      }
    />
  );
};

/**
 * The chat's first message: no pitch yet, the free model again on its own
 * after a short wait, with Try now to skip it.
 */
const FirstRetryLine = ({
  retryIn,
  onRetryNow,
}: {
  retryIn: number;
  onRetryNow(): void;
}) => {
  const { t } = useTranslation();
  return (
    <div
      className="bg-card my-2 flex w-full max-w-[520px] items-center gap-3 rounded-xl border p-3.5 text-sm"
      data-slot="free-model-down"
      data-moment="first"
    >
      <Loader2
        aria-hidden
        className="text-muted-foreground size-4 shrink-0 animate-spin"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-semibold">{t("freeModelDown.title")}</p>
        <p className="text-muted-foreground">
          {t("freeModelDown.firstRetrying", { seconds: retryIn })}
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        data-action="try-now"
        onClick={onRetryNow}
      >
        {t("freeModelDown.tryNow")}
      </Button>
    </div>
  );
};

/**
 * The free-model card for a run's failure: the first message's own retry, or
 * the card with its funnel events. Paying accounts never get here (status.tsx
 * reads the plan first).
 */
export const FreeModelDown = ({
  outcome,
  latest,
}: {
  outcome: RunOutcomeRecord;
  /** The thread's latest run: older failures show the card without a retry. */
  latest: boolean;
}) => {
  const { session, composer, slots } = useChatView();
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const wallTask = useCreditWallTask();
  const resume = useUpgradeResume();
  const outcomes = useThreadStore(session, (state) => state.runs.outcomes);
  const sentHere = useHost(session, () => session.sentHere(outcome.runId));
  const preview = slots.freeModelDownPreview ?? null;
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: preview == null,
    staleTime: 60_000,
  });
  const canReply = composer.readOnly == null && latest;
  // Only the run that just ended here retries by itself: never a chat reopened later.
  const ended = isLive(outcome) || sentHere;
  const first =
    preview?.first ??
    (canReply && ended && firstMessageFailed(outcomes, outcome.runId));
  const cause = (outcome.error as { cause?: string } | undefined)?.cause;
  const funnel = (step: FunnelStep, detail: string): void => {
    if (preview != null) return;
    void transport.client.system
      .funnelStep({ step, detail })
      .catch(() => undefined);
  };
  // The first message's own retry is due this long after the card came up.
  const [wait, setWait] = useState<Wait | null>(() =>
    first && !autoRetried.has(outcome.runId) ? waitOf(FIRST_RETRY_WAIT_S) : null
  );
  const retryNow = (how: "manual" | "first") => {
    setWait(null);
    if (how === "first") autoRetried.add(outcome.runId);
    funnel("free_model_down_retry", how);
    if (preview != null) return;
    void session
      .retry(
        composer.fixedMode ? { mode: composer.fixedMode } : undefined,
        t("workspace.retryMessage")
      )
      .catch(() => {});
  };
  const left = useSecondsLeft(wait, () => retryNow(first ? "first" : "manual"));
  const plan = preview?.billing ?? billing ?? null;
  const showing = plan != null && wallOffer(plan) != null;
  const shown = useEffectEvent(() => {
    if (shownRuns.has(outcome.runId)) return;
    shownRuns.add(outcome.runId);
    funnel("free_model_down_shown", first ? "first" : (cause ?? "busy"));
  });
  useEffect(() => {
    if (first || showing) shown();
  }, [first, showing]);

  // Further up the chat it is history: what happened, no second offer.
  if (!latest)
    return (
      <div
        className="text-muted-foreground my-1 text-sm"
        data-slot="free-model-down"
        data-moment="history"
      >
        {t("freeModelDown.history")}
      </div>
    );
  if (first && left != null)
    return (
      <FirstRetryLine retryIn={left} onRetryNow={() => retryNow("first")} />
    );
  if (plan == null) return null;
  const upgrade = () => {
    funnel("free_model_down_upgrade", cause ?? "busy");
    if (preview != null) return;
    // Called inside the click: the web build opens its tab here.
    void openUpgrade(transport.client, "free_model_down");
    const messages = session.hostStore.state.messages;
    const task = wallTask(messages);
    requestUpgradeDialog(
      {
        kind: "plan",
        key: `free-model-down:${outcome.runId}:${Date.now()}`,
        threadId: session.threadId,
        checkout: true,
        src: "free_model_down",
        ...(canReply && {
          pendingText: lastUserText(messages),
          resume: task.resume ?? resume,
          topModel: true,
        }),
      },
      true
    );
  };
  return (
    <FreeModelDownCard
      billing={plan}
      retryIn={left}
      onUpgrade={upgrade}
      onRetry={() => {
        if (canReply) setWait(waitOf(FREE_RETRY_WAIT_S));
      }}
    />
  );
};
