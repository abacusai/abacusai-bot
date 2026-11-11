/**
 * The way back down after a top model's first result, on a paid plan. Two
 * chats get one line under their clean result: the one whose waiting message
 * the upgrade sent again on a top model (useCreditWallTask in
 * upgrade-triggers.tsx), and any chat pinned to a top model on its first turn
 * while the app's default is not one (a continuation, a welcome's first task,
 * the user's own pick). The line offers the plan's own router in a new chat
 * from a summary (cheaper-model.ts), so the credits last, or to stay. Someone
 * whose default is a top model chose it and is never asked. Answers are kept
 * in memory: a restart can bring the line back under that same reply, never
 * under a later one.
 */
import { planTopModelIds } from "@abacus-ai/contract/billing-plan";
import {
  cheaperModelOffer,
  isTopModel,
} from "@abacus-ai/contract/cheaper-model";
import { resolveConfiguredModel } from "@abacus-ai/contract/models";
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
  const own = useStore(marks, (state) => state[session.threadId]);
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const [preparing, setPreparing] = useState(false);

  const turns = turnsOf(messages);
  const turn = turns.at(-1);
  const assistants = turn?.assistantIndices.map((index) => messages[index]!);
  const reply = assistants?.at(-1);
  // A chat pinned to its model, on its first turn: checked against the default below.
  const pinned = composer.model?.value ?? null;
  const firstPinned = turns.length === 1 && pinned != null;
  const tier = creditsTier(account);
  const ready =
    own?.answered !== true &&
    (own?.resumed === true || firstPinned) &&
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
  const { data: settings } = useQuery({
    ...transport.orpc.settings.get.queryOptions({ input: {} }),
    enabled: ready && own?.resumed !== true,
  });
  const planIds = planTopModelIds(billing);
  // The app's default as it runs: a top model there is the user's own choice.
  const defaultId =
    catalog != null && settings != null
      ? resolveConfiguredModel({
          requested: null,
          defaultModel: settings.defaultModel,
          catalog,
        })
      : undefined;
  const defaultRow = catalog?.find((model) => model.id === defaultId);
  const asked =
    own?.resumed === true ||
    (defaultId !== undefined &&
      (defaultRow == null || !isTopModel(defaultRow, planIds)));
  const offer =
    ready && asked && catalog != null && billing !== undefined
      ? cheaperModelOffer({
          plan: "paid",
          modelId: composer.model?.value ?? composer.model?.resolved ?? null,
          listed: true,
          catalog,
          planIds,
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
