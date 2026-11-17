/**
 * The onboarding offer test's card: the plan offer onboarding held back
 * (features/onboarding/first-result-offer.ts), once under the account's first
 * finished result, with the screen's words, the plan's price and whole pitch.
 * It stays on that reply until answered; a chat that moves on to another
 * reply passes it. The other cards under a reply yield to it while it is
 * owed.
 */
import { wallOffer } from "@abacus-ai/contract/billing-plan";
import {
  type FirstResultOfferMark,
  firstResultOfferPending,
} from "@abacus-ai/contract/first-result-offer";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { creditsTier } from "#renderer/lib/credits";
import { startPlanCheckout } from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { PitchCardFrame } from "./success-pitch";
import { useTailCardClaim } from "./tail-cards";
import { isLive } from "./upgrade-triggers";

export const FirstResultOfferRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer } = useChatView();
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
  const mark = prefs.dismissals.firstResultOffer ?? null;
  const reply = messages.findLast((each) => each.role === "assistant");
  const owed =
    mark != null &&
    firstResultOfferPending(mark) &&
    reply != null &&
    creditsTier(account) === "free" &&
    composer.readOnly == null &&
    !active;
  // The first finished result is the reply it shows under; it stays there.
  const eligible =
    owed &&
    (mark.shownOn != null
      ? mark.shownOn === reply.id
      : outcome?.kind === "success" && (isLive(outcome) || sentHere));
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: eligible,
    staleTime: 60_000,
  });
  const offer = billing != null ? wallOffer(billing) : null;
  const showing =
    eligible && billing != null && offer != null ? reply.id : null;

  const write = (next: FirstResultOfferMark): void => {
    void db
      .updatePrefs({ dismissals: { firstResultOffer: next } })
      .catch(() => undefined);
  };
  const funnel = (step: FunnelStep): void => {
    void transport.client.system.funnelStep({ step }).catch(() => undefined);
  };
  const shown = useEffectEvent((replyId: string) => {
    if (mark == null || mark.shownOn === replyId) return;
    funnel("first_result_offer_shown");
    write({ ...mark, shownOn: replyId });
  });
  useEffect(() => {
    if (showing != null) shown(showing);
  }, [showing]);
  // Shown under a reply the chat has left behind: passed, so the other cards get the reply.
  const passed = useEffectEvent(() => {
    if (mark != null) write({ ...mark, answered: "passed" });
  });
  const movedOn =
    owed && mark.shownOn != null && reply != null && mark.shownOn !== reply.id;
  useEffect(() => {
    if (movedOn) passed();
  }, [movedOn]);
  useTailCardClaim(session.threadId, showing);
  if (showing == null || billing == null || mark == null) return null;
  return (
    <PitchCardFrame
      slot="first-result-offer"
      moment="first_result"
      icon={<Sparkles className="size-4" />}
      title={t("onboarding.offer.title")}
      line={t("onboarding.offer.body")}
      lead={null}
      billing={billing}
      onUpgrade={() => {
        // Inside the click: the web build opens its checkout tab here.
        startPlanCheckout(transport.client, "first_result");
        funnel("first_result_offer_upgrade");
        write({ ...mark, shownOn: showing, answered: "upgrade" });
      }}
      onNotNow={() => {
        funnel("first_result_offer_skip");
        write({ ...mark, shownOn: showing, answered: "skip" });
      }}
    />
  );
};
