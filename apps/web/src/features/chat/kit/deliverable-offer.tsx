/**
 * The deliverable offer's row (contract deliverable-offer.ts): under the
 * latest reply when it was a long, structured answer that made no file. A
 * tap asks the agent for it as a document, as the user's next message; the
 * file then comes on the turn's deliverables card. Caps live in prefs.
 */
import {
  type DeliverableOfferCard,
  type DeliverableOfferKind,
  deliverableOfferAllowed,
  deliverableOfferIgnored,
  deliverableOfferKind,
  EMPTY_DELIVERABLE_OFFER_CARD,
} from "@abacus-ai/contract/deliverable-offer";
import { funnelDetail, type FunnelStep } from "@abacus-ai/contract/funnel";
import type { UIMessage } from "@tanstack/ai-client";
import { FileText, X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { componentToolBase } from "#renderer/lib/bot-turns/component-tools";
import { turnDeliverables } from "#renderer/lib/bot-turns/deliverables";
import { messageTools } from "#renderer/lib/bot-turns/tool-parts";
import {
  spokenParts,
  turnReplyText,
  turnsOf,
} from "#renderer/lib/bot-turns/turns";
import { useAppContext } from "#renderer/lib/use-app-context";
import { hiddenUserMessage, userMessageText } from "#renderer/lib/user-message";
import { Button } from "#renderer/ui/button";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { useSendAsUser } from "./send-as-user";
import { useTailCardClaim } from "./tail-cards";
import { isLive } from "./upgrade-triggers";

/** Tools that build or change something: such a turn was work, not an answer. */
const WORK_TOOLS = [
  "write",
  "edit",
  "write_file",
  "multi_edit",
  "patch",
  "notebook_edit",
  "bash",
  "serve",
];

export const isWorkTool = (name: string): boolean =>
  componentToolBase(name) != null ||
  WORK_TOOLS.some((tool) => name === tool || name.endsWith(`_${tool}`));

export interface DeliverableOfferTarget {
  /** The reply's message id. */
  id: string;
  /** The thread's turn it answered, counted from 1. */
  turn: number;
  kind: DeliverableOfferKind;
}

/**
 * The latest turn's reply, when it earns the offer: the user's own words
 * opened the turn, nothing in it built a file or showed a card or a notice,
 * and its final text reads as a piece of work.
 */
export const deliverableOfferTarget = (
  messages: readonly UIMessage[]
): DeliverableOfferTarget | null => {
  const turns = turnsOf(messages);
  const turn = turns.at(-1);
  if (turn == null || turn.userIndex < 0) return null;
  const opener = messages[turn.userIndex]!;
  if (hiddenUserMessage(opener) || userMessageText(opener).trim() === "")
    return null;
  const assistants = turn.assistantIndices.map((index) => messages[index]!);
  const carrier = assistants.at(-1);
  if (carrier == null) return null;
  const quiet = assistants.every((message) =>
    spokenParts(message).every(
      (part) => part.kind === "text" || part.kind === "subagent"
    )
  );
  if (
    !quiet ||
    assistants.some((message) =>
      messageTools(message).some((tool) => isWorkTool(tool.name))
    ) ||
    turnDeliverables(assistants).length > 0
  )
    return null;
  const kind = deliverableOfferKind(turnReplyText(assistants));
  return kind == null ? null : { id: carrier.id, turn: turns.length, kind };
};

export const DeliverableOfferRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer, slots, skin } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const sendAsUser = useSendAsUser();
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  // A tap hides the row at once, before the message lands.
  const [tapped, setTapped] = useState<string | null>(null);
  // The gallery shows it without the caps and keeps no answer.
  const preview = slots.deliverableOfferPreview === true;
  const target = deliverableOfferTarget(messages);
  const card = prefs.dismissals.deliverableOffer ?? null;
  // The success pitch owns the space under a reply it is offered on.
  const pitchHere =
    slots.successPitchOffer != null ||
    Object.entries(prefs.successPitch ?? {}).some(
      ([key, mark]) =>
        mark.offer?.sessionId === session.threadId &&
        prefs.dismissals.successPitchCards?.[key]?.answered !== mark.offer.id
    );
  const eligible =
    target != null &&
    !active &&
    composer.readOnly == null &&
    outcome?.kind === "success" &&
    tapped !== target.id &&
    card?.answered !== target.id &&
    !pitchHere;
  // A new offer only for a reply that just came in here, under the caps; once
  // shown it stays until answered or passed over.
  const ended = outcome != null && (isLive(outcome) || sentHere);
  const showing =
    eligible &&
    (preview ||
      card?.shownOffer === target.id ||
      (ended &&
        deliverableOfferAllowed(card, {
          id: target.id,
          threadId: session.threadId,
          turn: target.turn,
        })))
      ? target
      : null;

  const base: DeliverableOfferCard = card ?? EMPTY_DELIVERABLE_OFFER_CARD;
  const write = (next: DeliverableOfferCard): void => {
    if (preview) return;
    void db
      .updatePrefs({ dismissals: { deliverableOffer: next } })
      .catch(() => undefined);
  };
  const funnel = (step: FunnelStep, kind: DeliverableOfferKind): void => {
    if (preview) return;
    void transport.client.system
      .funnelStep({ step, detail: funnelDetail(`${kind}_${skin}`) })
      .catch(() => undefined);
  };
  // Counted once per reply, when it first comes on screen.
  const shown = useEffectEvent(() => {
    if (showing == null || card?.shownOffer === showing.id) return;
    funnel("deliverable_offer_shown", showing.kind);
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

  useTailCardClaim(session.threadId, showing?.id ?? null);
  if (showing == null) return null;
  const report = showing.kind === "report";
  const make = () =>
    sendAsUser(
      report
        ? t("chat.deliverableOffer.request.report")
        : t("chat.deliverableOffer.request.doc"),
      {
        accepted: () => {
          setTapped(showing.id);
          funnel("deliverable_offer_clicked", showing.kind);
          write({ ...base, answered: showing.id, misses: 0 });
        },
        failed: () => {
          setTapped(null);
          write(base);
        },
      }
    );
  const dismiss = () => {
    setTapped(showing.id);
    funnel("deliverable_offer_dismissed", showing.kind);
    write({
      ...base,
      answered: showing.id,
      misses: base.misses + 1,
      dismissed: base.dismissed + 1,
    });
  };
  return (
    <div
      data-slot="deliverable-offer"
      data-kind={showing.kind}
      role="group"
      aria-label={t("chat.deliverableOffer.label")}
      className="my-2 flex w-full max-w-[520px] flex-wrap items-center gap-1.5"
    >
      <Button
        size="sm"
        variant="outline"
        className="h-auto rounded-full py-1.5"
        data-action="make"
        onClick={make}
      >
        <FileText aria-hidden className="size-3.5 shrink-0" />
        {report
          ? t("chat.deliverableOffer.report")
          : t("chat.deliverableOffer.doc")}
      </Button>
      <span className="text-muted-foreground text-xs">
        {t("chat.deliverableOffer.hint")}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground size-7 rounded-full"
        aria-label={t("chat.deliverableOffer.dismiss")}
        data-action="dismiss"
        onClick={dismiss}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
};
