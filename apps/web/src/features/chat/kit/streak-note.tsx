/**
 * Places the daily streak's card under the reply that made today count. Once
 * a day, under that reply only, until closed or the next message. Only for a
 * reply the user just watched finish here, so an old chat opened later is left alone.
 */
import { localDay } from "@abacus-ai/contract/streak";
import type { UIMessage } from "@tanstack/ai-client";
import { useEffect, useEffectEvent, useState } from "react";

import { StreakCard } from "#renderer/components/streak/streak-card";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";

import { useChatView } from "./context";
import { useTailCardClaim } from "./tail-cards";

export const StreakNoteRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { session, composer, slots } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const now = useNow();
  const { data: account } = useAccount();
  const streak = account?.streak ?? null;
  const today = localDay(now);
  const mark = prefs.dismissals.streakNote ?? null;
  const latestReply = messages.findLast((each) => each.role === "assistant");
  // A run finished in this view: its reply is one the user just watched.
  const [watched, setWatched] = useState(active);
  if (active && !watched) setWatched(true);
  const preview = slots.successPitchOffer != null;
  const claimable =
    !preview &&
    streak != null &&
    streak.today_done &&
    watched &&
    !active &&
    composer.readOnly == null &&
    latestReply != null &&
    mark?.day !== today;
  const claim = useEffectEvent((replyId: string) => {
    void db
      .updatePrefs({
        dismissals: { streakNote: { day: today, replyId, closed: false } },
      })
      .catch(() => undefined);
    void transport.client.system
      .funnelStep({ step: "streak_card_shown", detail: String(streak?.day) })
      .catch(() => undefined);
  });
  const claimReply = claimable ? latestReply.id : null;
  useEffect(() => {
    if (claimReply != null) claim(claimReply);
  }, [claimReply]);
  const showing =
    streak != null &&
    !active &&
    mark != null &&
    mark.day === today &&
    !mark.closed &&
    latestReply?.id === mark.replyId;
  useTailCardClaim(session.threadId, showing ? mark.replyId : null);
  if (!showing) return null;
  const close = () => {
    void db
      .updatePrefs({ dismissals: { streakNote: { ...mark, closed: true } } })
      .catch(() => undefined);
    void transport.client.system
      .funnelStep({ step: "streak_card_closed", detail: String(streak.day) })
      .catch(() => undefined);
  };
  return <StreakCard streak={streak} now={now} onClose={close} />;
};
