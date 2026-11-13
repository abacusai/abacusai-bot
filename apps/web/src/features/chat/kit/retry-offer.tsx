import { planTopModelIds, wallOffer } from "@abacus-ai/contract/billing-plan";
/**
 * The retry offer's line (contract retry-offer.ts): under the latest reply
 * when a task went badly, the same task again on one of the plan's top
 * models, in a new chat that starts from a summary of this one
 * (continue-chat.ts): the top model reads a page instead of the whole stuck
 * history, and this chat keeps its model. A paying plan already runs the
 * model, so a tap starts it at once. A free plan runs the paid plans' Opus
 * there too, on its own credits (the server serves it for this retry), and
 * that chat pitches the plan after each turn (top-model-card.tsx); any other
 * top model opens the upgrade dialog with the message waiting. Only a listed
 * session chat has it. Caps live in prefs.
 */
import {
  isSuggestTasksTool,
  suggestsNextStep,
} from "@abacus-ai/contract/bots/suggested-tasks";
import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import {
  type DeliverableOfferCard,
  deliverableOfferAllowed,
  deliverableOfferIgnored,
  EMPTY_DELIVERABLE_OFFER_CARD,
} from "@abacus-ai/contract/deliverable-offer";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import {
  modelIdentity,
  retryOfferModel,
  type RetryOfferReason,
  retryOfferReason,
  TOP_MODEL_FAMILIES,
} from "@abacus-ai/contract/retry-offer";
import { EMPTY_TOP_MODEL_HINT_CARD } from "@abacus-ai/contract/top-model-hint";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { messageTools } from "#renderer/lib/bot-turns/tool-parts";
import { turnReplyText, turnsOf } from "#renderer/lib/bot-turns/turns";
import { creditsTier } from "#renderer/lib/credits";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError } from "#renderer/lib/toast";
import {
  lastUserText,
  requestUpgradeDialog,
} from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { hiddenUserMessage, userMessageText } from "#renderer/lib/user-message";
import { Button } from "#renderer/ui/button";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { deliverableOfferTarget, isWorkTool } from "./deliverable-offer";
import { useTailCardClaim } from "./tail-cards";
import { isLive } from "./upgrade-triggers";

export interface RetryOfferTarget {
  /** The reply's message id. */
  id: string;
  /** The thread's turn it answered, counted from 1. */
  turn: number;
  reason: RetryOfferReason;
}

/**
 * The latest turn's reply, when the task went badly: the user's own words
 * opened the turn, it shows no buttons of its own, and retryOfferReason finds
 * why.
 */
export const retryOfferTarget = (
  messages: readonly UIMessage[]
): RetryOfferTarget | null => {
  const turns = turnsOf(messages);
  const turn = turns.at(-1);
  if (turn == null || turn.userIndex < 0) return null;
  const opener = messages[turn.userIndex]!;
  if (hiddenUserMessage(opener)) return null;
  const ask = userMessageText(opener).trim();
  const assistants = turn.assistantIndices.map((index) => messages[index]!);
  const carrier = assistants.at(-1);
  if (ask === "" || carrier == null) return null;
  const tools = assistants.flatMap(messageTools);
  // Plain tasks are an offer of their own; a next step under a result yields to this line.
  if (
    tools.some(
      (tool) => isSuggestTasksTool(tool.name) && !suggestsNextStep(tool.input)
    )
  )
    return null;
  const ranWork = (indices: readonly number[]): boolean =>
    indices.some((index) =>
      messageTools(messages[index]!).some((tool) => isWorkTool(tool.name))
    );
  const earlier = turns
    .slice(0, -1)
    .filter(
      (each) =>
        each.userIndex >= 0 && !hiddenUserMessage(messages[each.userIndex]!)
    )
    .reverse();
  const reason = retryOfferReason({
    ask,
    earlierAsks: earlier.map((each) =>
      userMessageText(messages[each.userIndex]!)
    ),
    reply: turnReplyText(assistants),
    ranWork: ranWork(turn.assistantIndices),
    earlierRanWork: ranWork(earlier[0]?.assistantIndices ?? []),
  });
  return reason == null ? null : { id: carrier.id, turn: turns.length, reason };
};

/** A success pitch is waiting on this chat, unanswered: it owns the space under the reply. */
export const successPitchOnThread = (
  prefs: Pick<PrefsRow, "successPitch" | "dismissals">,
  threadId: string
): boolean =>
  Object.entries(prefs.successPitch ?? {}).some(
    ([each, mark]) =>
      mark.offer?.sessionId === threadId &&
      prefs.dismissals.successPitchCards?.[each]?.answered !== mark.offer.id
  );

export const RetryOfferRow = ({
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
  const { data: account } = useAccount();
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  // A tap hides the line at once, before the dialog answers.
  const [answered, setAnswered] = useState<string | null>(null);
  // A paying plan's tap waits on the summary with the line still up.
  const [preparing, setPreparing] = useState(false);
  // The gallery shows it on a model of its own, and keeps no answer.
  const preview = slots.retryOfferPreview ?? null;
  const tier = creditsTier(account);
  const free = tier === "free";
  // Every free and paying account gets it. A paying plan runs the top models
  // already, so it needs no upgrade.
  const paying = tier === "basic" || tier === "paid";
  const target = retryOfferTarget(messages);
  const card = prefs.dismissals.retryOffer ?? null;
  // The success pitch owns the space under a reply it is offered on.
  const pitchHere = successPitchOnThread(prefs, session.threadId);
  const eligible =
    target != null &&
    !active &&
    composer.readOnly == null &&
    outcome?.kind === "success" &&
    answered !== target.id &&
    card?.answered !== target.id &&
    deliverableOfferTarget(messages) == null &&
    (preview != null ||
      (IS_ELECTRON &&
        composer.onContinueInNewChat != null &&
        (free || paying) &&
        !pitchHere));
  const ended = outcome != null && (isLive(outcome) || sentHere);
  const allowed =
    eligible &&
    (preview != null ||
      card?.shownOffer === target.id ||
      (ended &&
        deliverableOfferAllowed(card, {
          id: target.id,
          threadId: session.threadId,
          turn: target.turn,
        })));
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: allowed && preview == null,
    staleTime: 60_000,
  });
  const { data: catalog } = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: allowed && preview == null,
    staleTime: 60_000,
  });
  const offer = billing != null && !paying ? wallOffer(billing) : null;
  const model =
    billing == null || catalog == null
      ? null
      : paying
        ? retryOfferModel(catalog, "runnable", planTopModelIds(billing))
        : offer != null
          ? retryOfferModel(catalog, "locked", planTopModelIds(billing))
          : null;
  // A chat already on that model has nothing to retry on.
  const current = composer.model?.value ?? composer.model?.resolved ?? null;
  const label =
    preview?.label ??
    (model != null && model.id !== current ? model.label : null);
  // A free plan's retry on the paid plans' Opus starts at once, like a paying one's.
  const freeTop =
    preview?.freeTop ??
    (free &&
      model != null &&
      modelIdentity(model.id).family === TOP_MODEL_FAMILIES.opus);
  const direct = paying || freeTop;
  const showing = allowed && label != null ? target : null;

  const base: DeliverableOfferCard = card ?? EMPTY_DELIVERABLE_OFFER_CARD;
  const write = (next: DeliverableOfferCard): void => {
    if (preview != null) return;
    void db
      .updatePrefs({ dismissals: { retryOffer: next } })
      .catch(() => undefined);
  };
  const funnel = (step: FunnelStep, reason: RetryOfferReason): void => {
    if (preview != null) return;
    void transport.client.system
      .funnelStep({
        step,
        detail: paying
          ? `${reason}_paid`
          : freeTop
            ? `${reason}_free_top`
            : reason,
      })
      .catch(() => undefined);
  };
  // The chat is on a top model now: the composer's top-model hint is done.
  const switched = (): void => {
    void db
      .updatePrefs({
        dismissals: {
          topModelHint: {
            ...(prefs.dismissals.topModelHint ?? EMPTY_TOP_MODEL_HINT_CARD),
            switched: true,
          },
        },
      })
      .catch(() => undefined);
  };
  // Counted once per reply, when it first comes on screen.
  const shown = useEffectEvent(() => {
    if (showing == null || card?.shownOffer === showing.id) return;
    funnel("retry_offer_shown", showing.reason);
    write({
      ...base,
      misses: base.misses + (deliverableOfferIgnored(card, showing.id) ? 1 : 0),
      shownOffer: showing.id,
      shownThread: session.threadId,
      shownTurn: showing.turn,
    });
  });
  const shownId = showing?.id ?? null;
  useEffect(() => {
    if (shownId != null) shown();
  }, [shownId]);

  useTailCardClaim(
    session.threadId,
    showing != null && label != null ? showing.id : null
  );
  if (showing == null || label == null) return null;
  const continueOn = async (id: string, reason: RetryOfferReason) => {
    const prompt = lastUserText(messages);
    await composer.onContinueInNewChat?.(id, prompt ?? undefined);
    funnel("retry_offer_resumed", reason);
    switched();
  };
  const retry = () => {
    funnel("retry_offer_tapped", showing.reason);
    if (model == null) return;
    const reason = showing.reason;
    const answer = () => write({ ...base, answered: showing.id, misses: 0 });
    if (direct) {
      // Up with a spinner until the new chat opens; a failure leaves it for another try.
      setPreparing(true);
      void continueOn(model.id, reason).then(answer, () => {
        showError(t("chat.continuation.failed"));
        setPreparing(false);
      });
      return;
    }
    answer();
    setAnswered(showing.id);
    const pendingText = lastUserText(messages);
    requestUpgradeDialog(
      {
        kind: "plan",
        key: `retry:${showing.id}`,
        threadId: session.threadId,
        src: "model_locked",
        ...(pendingText != null && { pendingText }),
        resume: () =>
          continueOn(model.id, reason).catch((error: unknown) => {
            showError(t("chat.continuation.failed"));
            throw error;
          }),
      },
      true
    );
  };
  const dismiss = () => {
    setAnswered(showing.id);
    funnel("retry_offer_dismissed", showing.reason);
    write({
      ...base,
      answered: showing.id,
      misses: base.misses + 1,
      dismissed: base.dismissed + 1,
    });
  };
  return (
    <div
      data-slot="retry-offer"
      data-reason={showing.reason}
      role="group"
      aria-label={t("chat.retryOffer.newChat", { model: label })}
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
          <p className="font-semibold">
            {t("chat.retryOffer.title", { model: label })}
          </p>
          <p className="text-muted-foreground">
            {paying
              ? // The plan runs it now, at a top model's price.
                t("chat.retryOffer.paidBody")
              : freeTop
                ? t("chat.retryOffer.freeTopModel", { model: label })
                : t("chat.composer.includedIn", {
                    plan: preview?.plan ?? offer?.planName,
                  })}
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
              : t("chat.retryOffer.continue")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            data-action="not-now"
            onClick={dismiss}
          >
            {t("upgradeDialog.notNow")}
          </Button>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-2 right-2 size-7"
        aria-label={t("chat.deliverableOffer.dismiss")}
        data-action="dismiss"
        onClick={dismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
};
