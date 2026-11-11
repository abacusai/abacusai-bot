/**
 * After an upgrade ran the waiting message on a top model (useCreditWallTask
 * in upgrade-triggers.tsx): once that turn ends with a clean result, one line
 * under it offers the way back down, the plan's own router in a new chat that
 * starts from a summary (cheaper-model.ts, continue-chat.ts), so the credits
 * last; or staying on the top model. Once per upgrade, kept in memory: a
 * restart in between drops the offer, never the result.
 */
import { planTopModelIds } from "@abacus-ai/contract/billing-plan";
import { cheaperModelOffer } from "@abacus-ai/contract/cheaper-model";
import { isCleanReply } from "@abacus-ai/contract/success-pitch";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { Store, useStore } from "@tanstack/react-store";
import { Leaf, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { turnReplyText, turnsOf } from "#renderer/lib/bot-turns/turns";
import { creditsTier } from "#renderer/lib/credits";
import { showError } from "#renderer/lib/toast";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { useTailCardClaim } from "./tail-cards";

interface TopModelResume {
  /** The top model the waiting message was sent again on. */
  model: string;
  /** The reply the offer first showed under: it stays there, never moves on. */
  replyId?: string;
}

/** Per chat: the upgrade's resume on a top model, until the offer is answered. */
const resumes = new Store<Record<string, TopModelResume>>({});

/** The upgrade is sending this chat's waiting message again on `model`. */
export const noteTopModelResume = (threadId: string, model: string): void =>
  resumes.setState((state) => ({ ...state, [threadId]: { model } }));

const settle = (threadId: string): void =>
  resumes.setState(({ [threadId]: _, ...rest }) => rest);

const pin = (threadId: string, replyId: string): void =>
  resumes.setState((state) => {
    const mark = state[threadId];
    return mark == null || mark.replyId === replyId
      ? state
      : { ...state, [threadId]: { ...mark, replyId } };
  });

export const RouterAfterUpgradeRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer } = useChatView();
  const { transport } = useAppContext();
  const { data: account } = useAccount();
  const mark = useStore(resumes, (state) => state[session.threadId]);
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const [preparing, setPreparing] = useState(false);

  const turn = mark == null ? undefined : turnsOf(messages).at(-1);
  const assistants = turn?.assistantIndices.map((index) => messages[index]!);
  const reply = assistants?.at(-1);
  const tier = creditsTier(account);
  const ready =
    mark != null &&
    reply != null &&
    !active &&
    outcome?.kind === "success" &&
    (mark.replyId == null || mark.replyId === reply.id) &&
    composer.readOnly == null &&
    composer.onContinueInNewChat != null &&
    (tier === "basic" || tier === "paid") &&
    isCleanReply(turnReplyText(assistants ?? []));
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: ready,
    staleTime: 60_000,
  });
  const { data: catalog } = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: ready,
    staleTime: 60_000,
  });
  const offer =
    ready && catalog != null && billing !== undefined
      ? cheaperModelOffer({
          plan: "paid",
          modelId: composer.model?.value ?? composer.model?.resolved ?? null,
          listed: true,
          catalog,
          planIds: planTopModelIds(billing),
        })
      : null;
  const showing = offer != null && reply != null ? reply.id : null;
  useEffect(() => {
    if (showing != null) pin(session.threadId, showing);
  }, [session.threadId, showing]);
  useTailCardClaim(session.threadId, showing);
  if (offer == null || showing == null) return null;

  const { current, target } = offer;
  const switchDown = () => {
    setPreparing(true);
    void composer.onContinueInNewChat?.(target.id).then(
      () => settle(session.threadId),
      () => {
        // Nothing opened: the line stays for another try.
        showError(t("chat.continuation.failed"));
        setPreparing(false);
      }
    );
  };
  return (
    <div
      data-slot="router-after-upgrade"
      role="group"
      aria-label={t("creditThreshold.switchCheaper", { model: target.label })}
      className="my-2 flex w-full max-w-[520px] flex-wrap items-center gap-1.5"
    >
      <Button
        size="sm"
        variant="outline"
        className="h-auto rounded-full py-1.5 text-left whitespace-normal"
        data-action="switch-cheaper"
        disabled={preparing}
        onClick={switchDown}
      >
        {preparing ? (
          <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Leaf aria-hidden className="size-3.5 shrink-0" />
        )}
        {preparing
          ? t("chat.continuation.preparing", { model: target.label })
          : t("creditThreshold.switchCheaper", { model: target.label })}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground h-auto rounded-full py-1.5"
        data-action="stay"
        disabled={preparing}
        onClick={() => settle(session.threadId)}
      >
        {t("chat.routerAfterUpgrade.stay", { model: current.label })}
      </Button>
    </div>
  );
};
