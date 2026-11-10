/**
 * The rating line (contract rating-prompt.ts): under the latest reply of a
 * chat worth rating, "how is the bot doing in this chat?" with four answers
 * and a close. A rating is sent at once; a short comment can follow it, and
 * goes with the same rating. It never shares a reply with another card
 * (tail-cards.ts), never follows one, never shows on a chat the user already
 * thumbed, and its caps live in prefs.
 */
import {
  creditAccountKey,
  pendingThreshold,
} from "@abacus-ai/contract/credit-thresholds";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import {
  CHAT_RATINGS,
  type ChatRating,
  EMPTY_RATING_PROMPT_CARD,
  keepThread,
  RATING_COMMENT_MAX,
  RATING_PROMPT_MIN_TURNS,
  type RatingPromptCard,
  ratingPromptAllowed,
  type RatingTaskType,
  ratingTaskType,
} from "@abacus-ai/contract/rating-prompt";
import { isComplaint } from "@abacus-ai/contract/success-pitch";
import { feedbackSegmentId } from "@abacus-ai/contract/transcript/feedback-target";
import type { UIMessage } from "@tanstack/ai-client";
import { X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { useThreadHasThumb } from "#renderer/components/message-feedback";
import { usePaymentRequired } from "#renderer/components/payment-required";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { messageTools } from "#renderer/lib/bot-turns/tool-parts";
import { spokenParts, turnsOf } from "#renderer/lib/bot-turns/turns";
import { useUpgradeDialogRequest } from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { hiddenUserMessage, userMessageText } from "#renderer/lib/user-message";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { isWorkTool } from "./deliverable-offer";
import { useTailCards } from "./tail-cards";
import { isLive } from "./upgrade-triggers";

export interface RatingPromptTarget {
  /** The reply's message id. */
  id: string;
  /** The transcript entry a rating names (feedback-target.ts). */
  segmentId: string;
  /** The user's own messages in the chat. */
  turns: number;
  taskType: RatingTaskType;
  /** The previous turn's replies, and whether that turn showed a card. */
  previousReplies: string[];
  previousCard: boolean;
}

/** A turn's reply showed a card of its own: an offer, the tasks, a notice. */
const showedCard = (assistants: readonly UIMessage[]): boolean =>
  assistants.some((message) =>
    spokenParts(message).some(
      (part) => part.kind !== "text" && part.kind !== "subagent"
    )
  );

/**
 * The latest turn's reply, when the chat is worth rating: the user's own
 * words (not a complaint) opened the turn, the reply says something and shows
 * no card, and the chat is long enough or the turn did real work.
 */
export const ratingPromptTarget = (
  messages: readonly UIMessage[]
): RatingPromptTarget | null => {
  const turns = turnsOf(messages);
  const turn = turns.at(-1);
  if (turn == null || turn.userIndex < 0) return null;
  const opener = messages[turn.userIndex]!;
  if (hiddenUserMessage(opener)) return null;
  const ask = userMessageText(opener).trim();
  if (ask === "" || isComplaint(ask)) return null;
  const assistants = turn.assistantIndices.map((index) => messages[index]!);
  if (showedCard(assistants)) return null;
  const carrier = assistants.findLast(
    (message) => feedbackSegmentId(message) != null
  );
  const segmentId = carrier == null ? null : feedbackSegmentId(carrier);
  if (carrier == null || segmentId == null) return null;
  const own = turns.filter(
    (each) =>
      each.userIndex >= 0 && !hiddenUserMessage(messages[each.userIndex]!)
  );
  const toolsOf = (indices: readonly number[]): string[] =>
    indices.flatMap((index) =>
      messageTools(messages[index]!).map((tool) => tool.name)
    );
  const latestTools = toolsOf(turn.assistantIndices);
  if (own.length < RATING_PROMPT_MIN_TURNS && !latestTools.some(isWorkTool))
    return null;
  const previous = turns.at(-2);
  const previousAssistants = (previous?.assistantIndices ?? []).map(
    (index) => messages[index]!
  );
  return {
    id: carrier.id,
    segmentId,
    turns: own.length,
    taskType: ratingTaskType(
      latestTools,
      turns.flatMap((each) => toolsOf(each.assistantIndices))
    ),
    previousReplies: previousAssistants.map((message) => message.id),
    previousCard: showedCard(previousAssistants),
  };
};

/** Lets the other cards under a reply claim it before the line asks. */
const SETTLE_MS = 1500;

/** Where the user is on one reply's line; the rating id is made at the first tap. */
type Phase =
  | { kind: "ask" }
  | { kind: "sending"; rating: ChatRating; ratingId: string }
  | { kind: "comment"; rating: ChatRating; ratingId: string }
  | { kind: "thanks" }
  | { kind: "failed"; ratingId: string };

const newRatingId = (): string => crypto.randomUUID();

/**
 * Pauses after each failed comment send, then one more try; the last pause
 * outlasts the server's hold on a send whose outcome it could not confirm
 * (ten minutes), so a comment is not given up while that hold lasts.
 */
const COMMENT_RETRY_MS = [5_000, 30_000, 120_000, 660_000, 0];

export const RatingPromptRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { t, i18n } = useTranslation();
  const { session, composer } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const now = useNow();
  const { data: account } = useAccount();
  const upgradeAsked = useUpgradeDialogRequest() != null;
  const payment = usePaymentRequired();
  const tail = useTailCards(session.threadId);
  const thumbed = useThreadHasThumb(session.threadId);
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  // Keyed by the reply it belongs to: another reply starts at the question.
  const [answer, setAnswer] = useState<{ on: string; phase: Phase } | null>(
    null
  );
  const [comment, setComment] = useState("");
  const [settledOn, setSettledOn] = useState<string | null>(null);
  // The reply the user is answering under: the line stays through the
  // comment and the thanks, though the rating is already kept.
  const [held, setHeld] = useState<string | null>(null);

  const card: RatingPromptCard =
    prefs.dismissals.ratingPrompt ?? EMPTY_RATING_PROMPT_CARD;
  const target = ratingPromptTarget(messages);
  const key = creditAccountKey(account);
  const milestoneOwed =
    key != null &&
    pendingThreshold(
      prefs.creditThresholds?.[key],
      prefs.dismissals.creditThresholdCards?.[key]
    ) != null;
  const shownHere = target != null && card.shownOffer === target.id;
  // Whatever happens around it, a line on screen stays until it is answered
  // or the chat moves on; a new one needs the moment to itself.
  const eligible =
    target != null &&
    account != null &&
    !active &&
    composer.readOnly == null &&
    outcome?.kind === "success" &&
    card.answered !== target.id;
  const quiet =
    eligible &&
    !tail.claimed &&
    !target.previousCard &&
    !target.previousReplies.some((id) => tail.had.includes(id)) &&
    !thumbed &&
    !upgradeAsked &&
    payment.data == null &&
    !milestoneOwed;
  const ended = outcome != null && (isLive(outcome) || sentHere);
  const fresh = quiet && ended && !card.off;

  const write = (next: RatingPromptCard): void => {
    void db
      .updatePrefs({ dismissals: { ratingPrompt: next } })
      .catch(() => undefined);
  };
  const funnel = (step: FunnelStep, detail: string): void => {
    void transport.client.system
      .funnelStep({ step, detail })
      .catch(() => undefined);
  };

  // A chat that could have been asked counts toward the next ask.
  const qualify = useEffectEvent((threadId: string) => {
    if (
      card.qualified.at(-1) === threadId ||
      card.askedThreads.includes(threadId)
    )
      return;
    write({ ...card, qualified: keepThread(card.qualified, threadId) });
  });
  const allowed = fresh && ratingPromptAllowed(card, session.threadId, now);
  useEffect(() => {
    if (fresh && !allowed) qualify(session.threadId);
  }, [fresh, allowed, session.threadId]);

  // Wait a moment after the run so another card can take the reply first.
  const candidate = allowed ? target.id : null;
  useEffect(() => {
    if (candidate == null) return;
    const timer = setTimeout(() => setSettledOn(candidate), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [candidate]);

  const showing =
    target != null && !active && held === target.id
      ? target
      : eligible && (shownHere || (quiet && allowed && settledOn === target.id))
        ? target
        : null;

  const shown = useEffectEvent(() => {
    const seen = showing;
    if (seen == null || card.shownOffer === seen.id) return;
    funnel("rating_prompt_shown", seen.taskType);
    write({
      ...card,
      shownOffer: seen.id,
      shownThread: session.threadId,
      shownAt: Date.now(),
      qualified: [],
      askedThreads: keepThread(card.askedThreads, session.threadId),
    });
  });
  const shownId = showing?.id ?? null;
  useEffect(() => {
    if (shownId != null) shown();
  }, [shownId]);

  if (showing == null) return null;
  const phase: Phase =
    answer?.on === showing.id ? answer.phase : { kind: "ask" };
  const setPhase = (next: Phase): void =>
    setAnswer({ on: showing.id, phase: next });

  const send = (rating: ChatRating, ratingId: string, text?: string) =>
    transport.client.agent.rate({
      sessionId: session.threadId,
      segmentId: showing.segmentId,
      ratingId,
      rating,
      taskType: showing.taskType,
      turns: showing.turns,
      locale: i18n.language,
      ...(text ? { comment: text } : {}),
    });

  const rate = (rating: ChatRating): void => {
    // A retry after a failed send keeps its id: the server counts it once.
    const ratingId = phase.kind === "failed" ? phase.ratingId : newRatingId();
    setHeld(showing.id);
    setComment("");
    setPhase({ kind: "sending", rating, ratingId });
    void send(rating, ratingId)
      .then((result) => {
        if (!result.ok) {
          setPhase({ kind: "failed", ratingId });
          return;
        }
        funnel("rating_prompt_answered", rating);
        write({ ...card, answered: showing.id, dismissStreak: 0 });
        setPhase({ kind: "comment", rating, ratingId });
      })
      .catch(() => setPhase({ kind: "failed", ratingId }));
  };
  const finish = (): void => setPhase({ kind: "thanks" });
  const sendComment = (rating: ChatRating, ratingId: string): void => {
    const text = comment.trim();
    if (text.length === 0) return finish();
    funnel("rating_prompt_commented", rating);
    // The line has said thanks: a comment the server could not take yet
    // (busy, or the post failed) is sent again a couple of times, same id.
    void (async () => {
      for (const wait of COMMENT_RETRY_MS) {
        const outcome = await send(rating, ratingId, text).catch(() => null);
        if (outcome?.ok) return;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    })();
    finish();
  };
  const dismiss = (): void => {
    funnel("rating_prompt_dismissed", showing.taskType);
    write({
      ...card,
      answered: showing.id,
      dismissStreak: card.dismissStreak + 1,
      dismissedAt: Date.now(),
    });
  };

  if (phase.kind === "thanks")
    return (
      <p
        data-slot="rating-prompt"
        data-phase="thanks"
        className="text-muted-foreground my-2 text-xs"
      >
        {t("chat.ratingPrompt.thanks")}
      </p>
    );

  if (phase.kind === "comment") {
    const low = phase.rating === "bad" || phase.rating === "okay";
    return (
      <form
        data-slot="rating-prompt"
        data-phase="comment"
        className="my-2 flex w-full max-w-[520px] flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          sendComment(phase.rating, phase.ratingId);
        }}
      >
        <label
          htmlFor={`rating-comment-${showing.id}`}
          className="text-muted-foreground w-full text-xs"
        >
          {t(
            low ? "chat.ratingPrompt.whatWrong" : "chat.ratingPrompt.whatGood"
          )}
        </label>
        <Input
          id={`rating-comment-${showing.id}`}
          className="h-8 min-w-0 flex-1 text-sm"
          value={comment}
          maxLength={RATING_COMMENT_MAX}
          placeholder={t("chat.ratingPrompt.privacy")}
          autoFocus
          onChange={(event) => setComment(event.target.value)}
        />
        <Button type="submit" size="sm" className="h-8 rounded-full">
          {t("chat.ratingPrompt.send")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground h-8 rounded-full"
          onClick={finish}
        >
          {t("chat.ratingPrompt.skip")}
        </Button>
      </form>
    );
  }

  return (
    <div
      data-slot="rating-prompt"
      data-phase={phase.kind}
      role="group"
      aria-label={t("chat.ratingPrompt.question")}
      className="my-2 flex w-full max-w-[520px] flex-wrap items-center gap-1.5"
    >
      <span className="text-muted-foreground mr-1 text-xs">
        {phase.kind === "failed"
          ? t("chat.ratingPrompt.failed")
          : t("chat.ratingPrompt.question")}
      </span>
      {CHAT_RATINGS.map((rating) => (
        <Button
          key={rating}
          size="sm"
          variant="outline"
          className="h-7 rounded-full px-3 text-xs"
          data-rating={rating}
          disabled={phase.kind === "sending"}
          aria-pressed={phase.kind === "sending" && phase.rating === rating}
          onClick={() => rate(rating)}
        >
          {t(`chat.ratingPrompt.${rating}`)}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground size-7 rounded-full"
        aria-label={t("chat.ratingPrompt.dismiss")}
        data-action="dismiss"
        onClick={dismiss}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
};
