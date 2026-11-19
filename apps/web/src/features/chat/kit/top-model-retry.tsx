/**
 * The card under a free account's finished reply: the paid plans' top model,
 * one tap away. What the tap does is the server's top-model retry 50/50
 * (#renderer/lib/opus-retry): "opus" continues the task on that model in a
 * new chat, on the account's own credits, where the top-model card pitches the
 * plan after each turn; "dialog" opens the upgrade dialog naming the model,
 * and the task continues there once the plan is active. Only a session chat
 * that can continue in a new chat has it, it never shares the space under a
 * reply with another card, and its × closes it for good.
 */
import type { OpusRetryArm } from "@abacus-ai/contract/billing-plan";
import { planTopModelIds, wallOffer } from "@abacus-ai/contract/billing-plan";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import { retryOfferModel } from "@abacus-ai/contract/retry-offer";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { useOpusRetryArm } from "#renderer/lib/opus-retry";
import { showError } from "#renderer/lib/toast";
import {
  lastUserText,
  requestUpgradeDialog,
} from "#renderer/lib/upgrade-dialog";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { successPitchOnThread } from "./retry-offer";
import { useTailCardClaim, useTailCards } from "./tail-cards";
import { isLive } from "./upgrade-triggers";

/** Replies the card was counted under, so a re-render never counts it twice. */
const shownOn = new Set<string>();

export const TopModelRetryRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer, slots } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const liveArm = useOpusRetryArm();
  const tail = useTailCards(session.threadId);
  // The gallery shows it for an arm of its own, and keeps no answer.
  const preview = slots.topModelRetryPreview ?? null;
  const arm: OpusRetryArm | null = preview?.arm ?? liveArm;
  const closed = prefs.dismissals.topModelRetryClosedAt != null;
  // Up with a spinner until the new chat opens.
  const [preparing, setPreparing] = useState(false);
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  const reply = messages.findLast((each) => each.role === "assistant");
  // Under the reply that just ended, while no card claims it; a card already
  // up keeps its place when another claims later.
  const eligible =
    reply != null &&
    (preview != null ||
      (arm != null &&
        !closed &&
        !active &&
        composer.readOnly == null &&
        composer.onContinueInNewChat != null &&
        outcome?.kind === "success" &&
        (isLive(outcome) || sentHere) &&
        !successPitchOnThread(prefs, session.threadId) &&
        (!tail.claimed || shownOn.has(reply.id))));
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: eligible && preview == null,
    staleTime: 60_000,
  });
  const { data: catalog } = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: eligible && preview == null,
    staleTime: 60_000,
  });
  // The plan's Opus, by catalog id, as the retry offer picks it.
  const model =
    billing != null && catalog != null
      ? retryOfferModel(catalog, "locked", planTopModelIds(billing))
      : null;
  const current = composer.model?.value ?? composer.model?.resolved ?? null;
  const label =
    preview?.label ??
    (model != null && model.id !== current ? model.label : null);
  const plan =
    preview?.plan ?? (billing != null ? wallOffer(billing)?.planName : null);
  const showing =
    eligible && reply != null && label != null && plan != null && arm != null
      ? reply.id
      : null;

  const funnel = (step: FunnelStep): void => {
    if (preview != null || arm == null) return;
    void transport.client.system
      .funnelStep({ step, detail: arm })
      .catch(() => undefined);
  };
  const shown = useEffectEvent(() => {
    if (showing == null || shownOn.has(showing)) return;
    shownOn.add(showing);
    funnel("top_model_retry_shown");
  });
  useEffect(() => {
    if (showing != null) shown();
  }, [showing]);
  useTailCardClaim(session.threadId, showing);
  if (showing == null || label == null || plan == null || arm == null)
    return null;

  const continueOn = async (id: string): Promise<void> => {
    await composer.onContinueInNewChat?.(
      id,
      lastUserText(messages) ?? undefined
    );
  };
  const retry = (): void => {
    funnel("top_model_retry_tapped");
    if (preview != null || model == null) return;
    if (arm === "opus") {
      setPreparing(true);
      void continueOn(model.id).then(
        () => setPreparing(false),
        () => {
          showError(t("chat.continuation.failed"));
          setPreparing(false);
        }
      );
      return;
    }
    const pendingText = lastUserText(messages);
    requestUpgradeDialog(
      {
        kind: "plan",
        key: `top-model-retry:${showing}`,
        threadId: session.threadId,
        src: "retry_top_model",
        model: label,
        ...(pendingText != null && { pendingText }),
        resume: () =>
          continueOn(model.id).catch((error: unknown) => {
            showError(t("chat.continuation.failed"));
            throw error;
          }),
      },
      true
    );
  };
  const close = (): void => {
    funnel("top_model_retry_closed");
    if (preview != null) return;
    void db
      .updatePrefs({ dismissals: { topModelRetryClosedAt: Date.now() } })
      .catch(() => undefined);
  };
  return (
    <div
      data-slot="top-model-retry"
      data-arm={arm}
      role="group"
      aria-label={label}
      className="relative my-2 flex w-full max-w-[520px] gap-3 rounded-xl border border-violet-200 bg-violet-50/70 p-3.5 pr-9 text-sm dark:border-violet-900/70 dark:bg-violet-950/30"
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-violet-600 text-white"
      >
        <Sparkles className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold">{label}</p>
          <p className="text-muted-foreground">
            {arm === "opus"
              ? t("chat.topModelRetry.opusBody")
              : t("chat.topModelRetry.dialogBody", { plan })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            className="bg-violet-600 text-white hover:bg-violet-700"
            data-action="retry"
            disabled={preparing}
            onClick={retry}
          >
            {preparing ? (
              <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <RotateCcw aria-hidden className="size-3.5 shrink-0" />
            )}
            {preparing
              ? t("chat.continuation.preparing", { model: label })
              : t("chat.topModelRetry.retry", { model: label })}
          </Button>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-2 right-2 size-7"
        aria-label={t("chat.topModelRetry.dismiss")}
        data-action="dismiss"
        onClick={close}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
};
