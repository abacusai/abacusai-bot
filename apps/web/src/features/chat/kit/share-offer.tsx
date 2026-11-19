/**
 * "Send it to anyone": under the reply that made the chat's first page or
 * document, one card offering its public link. Get a link opens the shell's
 * share dialog for that file; Not now closes it. Once per chat, gone once the
 * file has a link, and never beside another card under the same reply.
 */
import {
  isSuggestTasksTool,
  suggestsNextStep,
} from "@abacus-ai/contract/bots/suggested-tasks";
import {
  EMPTY_SHARE_OFFER_CARD,
  preferredShare,
  shareOfferAllowed,
  type ShareOfferCard,
  shareOfferThreads,
} from "@abacus-ai/contract/share";
import type { UIMessage } from "@tanstack/ai-client";
import { useStore } from "@tanstack/react-store";
import { Link2 } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolveWorkspacePath } from "#renderer/components/file-preview";
import { useCanShare } from "#renderer/components/share/share-row-button";
import {
  linkedPathsStore,
  requestShare,
} from "#renderer/components/share/share-store";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { turnDeliverables } from "#renderer/lib/bot-turns/deliverables";
import { messageTools } from "#renderer/lib/bot-turns/tool-parts";
import { turnsOf } from "#renderer/lib/bot-turns/turns";
import { useAppContext } from "#renderer/lib/use-app-context";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { successPitchOnThread } from "./retry-offer";
import { OfferCardFrame } from "./success-pitch";
import { useTailCardClaim, useTailCards } from "./tail-cards";
import { isLive } from "./upgrade-triggers";

/** Lets the other cards under a reply claim it first, as the rating line does. */
const SETTLE_MS = 1500;
/** Its name on the space under a reply: any other claim there wins. */
const SHARE_OWNER = "share";

export interface ShareOfferTarget {
  /** The reply's message id. */
  id: string;
  /** The thread's turn it answered, counted from 1. */
  turn: number;
  /** The file to share, as the turn named it. */
  path: string;
  /** The turn also offers a next step. */
  nextStep: boolean;
}

/** The latest turn's reply, when that turn handed over a file that can be shared. */
export const shareOfferTarget = (
  messages: readonly UIMessage[]
): ShareOfferTarget | null => {
  const turns = turnsOf(messages);
  const turn = turns.at(-1);
  if (turn == null) return null;
  const assistants = turn.assistantIndices.map((index) => messages[index]!);
  const carrier = assistants.at(-1);
  if (carrier == null) return null;
  const path = preferredShare(
    turnDeliverables(assistants)
      .filter((item) => !item.isUrl)
      .map((item) => item.path)
  );
  if (path == null) return null;
  const nextStep = assistants
    .flatMap(messageTools)
    .some(
      (tool) => isSuggestTasksTool(tool.name) && suggestsNextStep(tool.input)
    );
  return { id: carrier.id, turn: turns.length, path, nextStep };
};

/** The card, with its buttons; the gallery shows it as it is. */
export const ShareOfferCardView = ({
  onGetLink,
  onNotNow,
}: {
  onGetLink(): void;
  onNotNow(): void;
}) => {
  const { t } = useTranslation();
  return (
    <OfferCardFrame
      slot="share-offer"
      tone="plain"
      icon={<Link2 className="size-4" />}
      title={t("share.offer.title")}
      line={t("share.offer.body")}
      action={{
        label: t("share.offer.getLink"),
        name: "get-link",
        onClick: onGetLink,
      }}
      notNow={{ label: t("share.offer.notNow"), onClick: onNotNow }}
    />
  );
};

export const ShareOfferRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { session, composer, slots, workspaceRoot } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const canShare = useCanShare();
  const tail = useTailCards(session.threadId);
  const linked = useStore(linkedPathsStore);
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  // An answer hides it at once, before prefs come back.
  const [answered, setAnswered] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  // The gallery shows it without the once-per-chat rule and keeps no answer.
  const preview = slots.shareOfferPreview === true;
  const target = shareOfferTarget(messages);
  const card = prefs.dismissals.shareOffer ?? null;
  const base: ShareOfferCard = card ?? EMPTY_SHARE_OFFER_CARD;
  const path =
    target == null ? null : resolveWorkspacePath(target.path, workspaceRoot);
  const nextStepCard = prefs.dismissals.nextStepOffer;
  // A next step shown under this reply has the space.
  const nextStepHere =
    target?.nextStep === true &&
    nextStepCard?.shownThread === session.threadId &&
    nextStepCard.shownTurn === target.turn &&
    nextStepCard.answered !== nextStepCard.shownOffer;
  const othersHere = tail.owners.some((owner) => owner !== SHARE_OWNER);
  const eligible =
    target != null &&
    path != null &&
    (canShare || preview) &&
    !active &&
    composer.readOnly == null &&
    outcome?.kind === "success" &&
    answered !== target.id &&
    !linked.has(path) &&
    !othersHere &&
    !nextStepHere &&
    !successPitchOnThread(prefs, session.threadId) &&
    slots.successPitchOffer == null;
  const ended = outcome != null && (isLive(outcome) || sentHere);
  const candidate =
    eligible &&
    (preview ||
      card?.shownOffer === target.id ||
      (ended &&
        shareOfferAllowed(card, { id: target.id, threadId: session.threadId })))
      ? target
      : null;
  const candidateId = candidate?.id ?? null;
  useEffect(() => {
    if (candidateId == null) return;
    const timer = setTimeout(() => setSettled(candidateId), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [candidateId]);
  const showing =
    candidate != null &&
    (preview || card?.shownOffer === candidate.id || settled === candidate.id)
      ? candidate
      : null;

  const write = (next: ShareOfferCard): void => {
    if (preview) return;
    void db
      .updatePrefs({ dismissals: { shareOffer: next } })
      .catch(() => undefined);
  };
  const funnel = (step: "share_card_shown" | "share_card_not_now"): void => {
    if (preview) return;
    void transport.client.system
      .funnelStep({ step, detail: "card" })
      .catch(() => undefined);
  };
  // Counted once, when it first comes on screen; the chat never gets it again.
  const shown = useEffectEvent(() => {
    if (showing == null || card?.shownOffer === showing.id) return;
    funnel("share_card_shown");
    write({
      ...base,
      shownOffer: showing.id,
      shownThread: session.threadId,
      threads: shareOfferThreads(base, session.threadId),
    });
  });
  const shownId = showing?.id ?? null;
  useEffect(() => {
    if (shownId != null) shown();
  }, [shownId]);
  // A link made from the row or the header answers it too.
  const linkedHere =
    target != null &&
    path != null &&
    card?.shownOffer === target.id &&
    card.answered !== target.id &&
    linked.has(path);
  const settle = useEffectEvent(() => {
    if (target != null) write({ ...base, answered: target.id });
  });
  useEffect(() => {
    if (linkedHere) settle();
  }, [linkedHere]);

  useTailCardClaim(
    session.threadId,
    showing == null ? null : showing.id,
    SHARE_OWNER
  );
  if (showing == null || path == null) return null;
  const answer = () => {
    setAnswered(showing.id);
    write({ ...base, answered: showing.id });
  };
  return (
    <ShareOfferCardView
      onGetLink={() => {
        answer();
        requestShare(path, "card");
      }}
      onNotNow={() => {
        answer();
        funnel("share_card_not_now");
      }}
    />
  );
};
