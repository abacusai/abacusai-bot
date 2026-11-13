/**
 * Under every reply a free account gets from a top model its plan does not
 * include (the retry offer's Opus, run on the account's own credits): one card
 * to keep going on it with the plan, with its price and whole list. It comes
 * back after each turn, since every turn there spends credits fast; Not now
 * hides it until the next reply. It yields to the success pitch, and the
 * credit milestones and the wall stay theirs.
 */
import { wallOffer } from "@abacus-ai/contract/billing-plan";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "#renderer/data/db/prefs";
import { creditsTier } from "#renderer/lib/credits";
import { startPlanCheckout } from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { successPitchOnThread } from "./retry-offer";
import { PitchCardFrame } from "./success-pitch";
import { useTailCardClaim } from "./tail-cards";
import { isLive } from "./upgrade-triggers";

/** The reply each chat's card was last answered on: Not now lasts until the next reply. */
const answeredOn = new Map<string, string>();

export const TopModelCardRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer, slots } = useChatView();
  const { transport } = useAppContext();
  const prefs = usePrefs();
  const { data: account } = useAccount();
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  const [, setAnswered] = useState<string | null>(null);
  const preview = slots.topModelCardPreview ?? null;
  const reply = messages.findLast((each) => each.role === "assistant");
  const model = composer.model?.value ?? null;
  const eligible =
    preview != null ||
    (creditsTier(account) === "free" &&
      reply != null &&
      model != null &&
      !active &&
      composer.readOnly == null &&
      outcome?.kind === "success" &&
      (isLive(outcome) || sentHere) &&
      answeredOn.get(session.threadId) !== reply.id &&
      !successPitchOnThread(prefs, session.threadId));
  const { data: live } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: eligible && preview == null,
    staleTime: 60_000,
  });
  const billing = preview?.billing ?? live;
  // Only a top model the plan unlocks: the free models never get it.
  const topModel =
    billing == null || model == null
      ? null
      : ((billing.topModels ?? []).find(
          (each) => `abacus/${each.id}` === model
        ) ?? null);
  const offer = billing != null ? wallOffer(billing) : null;
  const label = preview?.label ?? topModel?.name ?? null;
  const showing =
    eligible && billing != null && offer != null && label != null
      ? (reply?.id ?? "preview")
      : null;

  const funnel = (step: FunnelStep): void => {
    if (preview != null) return;
    void transport.client.system
      .funnelStep({ step, detail: model ?? "" })
      .catch(() => undefined);
  };
  const shown = useEffectEvent(() => funnel("top_model_card_shown"));
  useEffect(() => {
    if (showing != null) shown();
  }, [showing]);
  useTailCardClaim(session.threadId, showing);
  if (showing == null || billing == null || offer == null || label == null)
    return null;

  const answer = (): void => {
    if (preview != null) return;
    answeredOn.set(session.threadId, showing);
    setAnswered(showing);
  };
  return (
    <PitchCardFrame
      slot="top-model-card"
      moment="top_model"
      icon={<Sparkles className="size-4" />}
      title={t("chat.topModelCard.title", {
        model: label,
        plan: offer.planName,
      })}
      line={t("chat.topModelCard.line", {
        model: label,
        plan: offer.planName,
      })}
      lead="models"
      billing={billing}
      onUpgrade={() => {
        // Inside the click: the web build opens its checkout tab here.
        startPlanCheckout(transport.client, "model_locked");
        funnel("top_model_card_upgrade");
        answer();
      }}
      onNotNow={() => {
        funnel("top_model_card_not_now");
        answer();
      }}
    />
  );
};
