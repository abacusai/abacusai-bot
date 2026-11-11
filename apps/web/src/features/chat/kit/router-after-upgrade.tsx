/**
 * The way back down after a top model's first result. A chat the app moved
 * onto a top model, either the upgrade's resume of the waiting message
 * (useCreditWallTask in upgrade-triggers.tsx) or a chat continued in a new
 * one (continue-chat.ts, `continuedFrom`) on its first turn, gets one line
 * under its clean result once the plan is paid: the plan's own router in a
 * new chat from a summary (cheaper-model.ts), so the credits last, or stay on
 * the top model. Answers are kept in memory: a restart can bring the line
 * back under that same reply, never under a later one.
 */
import { planTopModelIds } from "@abacus-ai/contract/billing-plan";
import { cheaperModelOffer } from "@abacus-ai/contract/cheaper-model";
import { isCleanReply } from "@abacus-ai/contract/success-pitch";
import type { UIMessage } from "@tanstack/ai-client";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { Store, useStore } from "@tanstack/react-store";
import { Leaf, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { turnReplyText, turnsOf } from "#renderer/lib/bot-turns/turns";
import { creditsTier } from "#renderer/lib/credits";
import { showError } from "#renderer/lib/toast";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { useTailCardClaim } from "./tail-cards";

interface RouterOfferMark {
  /** The upgrade sent this chat's waiting message again on a top model. */
  resumed?: boolean;
  /** The reply the offer first showed under: it stays there, never moves on. */
  replyId?: string;
  /** Continued or stayed: never again in this chat. */
  answered?: boolean;
}

/** Per chat: the upgrade's resume and the offer's answer. */
const marks = new Store<Record<string, RouterOfferMark>>({});

const mark = (threadId: string, patch: RouterOfferMark): void =>
  marks.setState((state) => ({
    ...state,
    [threadId]: { ...state[threadId], ...patch },
  }));

/** The upgrade is sending this chat's waiting message again on a top model. */
export const noteTopModelResume = (threadId: string): void =>
  marks.setState((state) => ({ ...state, [threadId]: { resumed: true } }));

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
  const collections = useCollections();
  const threadId = session.threadId;
  // The chat's row (a bot's chat has none): a continuation names its source.
  const continuedFrom = useLiveQuery({
    queryKey: ["router-after-upgrade", threadId],
    query: (q) =>
      q
        .from({ s: collections.sessions })
        .where(({ s }) => eq(s.id, threadId))
        .findOne(),
  }).data?.continuedFrom;
  const own = useStore(marks, (state) => state[session.threadId]);
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const [preparing, setPreparing] = useState(false);

  const turns = turnsOf(messages);
  const turn = turns.at(-1);
  const assistants = turn?.assistantIndices.map((index) => messages[index]!);
  const reply = assistants?.at(-1);
  // A chat continued in a new one: its first turn's result.
  const continued = turns.length === 1 && continuedFrom != null;
  const tier = creditsTier(account);
  const ready =
    own?.answered !== true &&
    (own?.resumed === true || continued) &&
    reply != null &&
    !active &&
    outcome?.kind === "success" &&
    (own?.replyId == null || own.replyId === reply.id) &&
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
    if (showing != null) mark(session.threadId, { replyId: showing });
  }, [session.threadId, showing]);
  useTailCardClaim(session.threadId, showing);
  if (offer == null || showing == null) return null;

  const { current, target } = offer;
  const switchDown = () => {
    setPreparing(true);
    void composer.onContinueInNewChat?.(target.id).then(
      () => mark(session.threadId, { answered: true }),
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
        onClick={() => mark(session.threadId, { answered: true })}
      >
        {t("chat.routerAfterUpgrade.stay", { model: current.label })}
      </Button>
    </div>
  );
};
