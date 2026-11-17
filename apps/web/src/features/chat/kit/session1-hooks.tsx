/**
 * The session-1 coin toss (the billing plan's `session1Hooks`): a free
 * account in its hooks arm gets one line under each finished reply, "Retry
 * with <top model>": the plan dialog naming that model, and once the plan is
 * active the reply runs again on it, in this chat. The arm read and the picker
 * beacon are in #renderer/lib/session1-hooks. The control arm and every paid
 * plan get nothing from here.
 */
import { planTopModelIds } from "@abacus-ai/contract/billing-plan";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import { retryOfferModel } from "@abacus-ai/contract/retry-offer";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { RotateCcw, X } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { creditsTier } from "#renderer/lib/credits";
import { useSession1Hooks } from "#renderer/lib/session1-hooks";
import {
  lastUserText,
  requestUpgradeDialog,
} from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { useTailCardClaim, useTailCards } from "./tail-cards";
import { isLive, useUpgradeResume } from "./upgrade-triggers";

/** Replies the line was counted under. Its × is kept in prefs. */
const shownOn = new Set<string>();

export const Session1RetryRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer } = useChatView();
  const { transport } = useAppContext();
  const hooks = useSession1Hooks();
  const tail = useTailCards(session.threadId);
  const db = useDb();
  const closed = usePrefs().dismissals.session1RetryClosedAt != null;
  const { data: account } = useAccount();
  // This chat alone moves onto the model, and the last ask runs again there.
  const resume = useUpgradeResume({ thisChatOnly: true });
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  const reply = messages.findLast((each) => each.role === "assistant");
  // Under the reply that just ended, while no card claims it; a line already
  // up keeps its place when a card claims later.
  const eligible =
    hooks &&
    !closed &&
    reply != null &&
    !active &&
    composer.readOnly == null &&
    outcome?.kind === "success" &&
    (isLive(outcome) || sentHere) &&
    (!tail.claimed || shownOn.has(reply.id));
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: eligible,
    staleTime: 60_000,
  });
  const { data: catalog } = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: eligible,
    staleTime: 60_000,
  });
  // The plan's Opus, by catalog id, as the retry offer picks it.
  const model =
    billing != null && catalog != null
      ? retryOfferModel(catalog, "locked", planTopModelIds(billing))
      : null;
  const showing = eligible && reply != null && model != null ? reply.id : null;

  const funnel = (step: FunnelStep): void => {
    void transport.client.system
      .funnelStep({ step, detail: model?.id ?? "" })
      .catch(() => undefined);
  };
  const shown = useEffectEvent(() => {
    if (showing == null || shownOn.has(showing)) return;
    shownOn.add(showing);
    funnel("session1_retry_shown");
  });
  useEffect(() => {
    if (showing != null) shown();
  }, [showing]);
  useTailCardClaim(session.threadId, showing);
  if (showing == null || model == null) return null;

  return (
    <div
      data-slot="session1-retry"
      role="group"
      aria-label={t("chat.session1Retry.retry", { model: model.label })}
      className="my-2 flex w-full max-w-[520px] items-center gap-1.5"
    >
      <Button
        size="sm"
        variant="outline"
        className="h-7 rounded-full px-3 text-xs"
        data-action="retry"
        onClick={() => {
          funnel("session1_retry_click");
          const tier = creditsTier(account);
          if (tier === "basic" || tier === "paid") {
            void resume(model.id);
            return;
          }
          const pendingText = lastUserText(messages);
          requestUpgradeDialog(
            {
              kind: "plan",
              key: `session1:${showing}`,
              threadId: session.threadId,
              src: "retry_top_model",
              model: model.label,
              ...(pendingText != null && { pendingText }),
              resume: () => resume(model.id),
            },
            true
          );
        }}
      >
        <RotateCcw aria-hidden className="size-3.5 shrink-0" />
        {t("chat.session1Retry.retry", { model: model.label })}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground size-7 rounded-full"
        aria-label={t("chat.session1Retry.dismiss")}
        data-action="dismiss"
        onClick={() => {
          void db
            .updatePrefs({ dismissals: { session1RetryClosedAt: Date.now() } })
            .catch(() => undefined);
        }}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
};
