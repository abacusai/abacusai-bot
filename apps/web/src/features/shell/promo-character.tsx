import { eq, useLiveQuery } from "@tanstack/react-db";
import { useRouterState } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { useCollections } from "#renderer/data/db";
import {
  defaultLook,
  resolveLook,
  type AvatarMood,
} from "#renderer/lib/bots/avatar";
import { durations, offsets, useMotionPreference } from "#renderer/lib/motion";

/** Semantic names isolate the card from future character-expression additions. */
export const PROMO_MOODS = {
  hopeful: "waiting",
  worried: "blocked",
  exhausted: "asleep",
  excited: "excited",
  upgraded: "happy",
  welcome: "happy",
  idle: "wink",
} as const satisfies Record<string, AvatarMood>;
export const creditMood = (
  remaining: number | null,
  total: number | null
): AvatarMood =>
  remaining === 0
    ? PROMO_MOODS.exhausted
    : remaining != null &&
        total != null &&
        total > 0 &&
        remaining / total <= 0.1
      ? PROMO_MOODS.worried
      : PROMO_MOODS.hopeful;

export const PromoCharacter = ({
  remaining,
  total,
  excited,
  upgraded,
}: {
  remaining: number | null;
  total: number | null;
  excited: boolean;
  upgraded: boolean;
}) => {
  const reduced = useMotionPreference() === "reduced";
  const collections = useCollections();
  const botId = useRouterState({
    select: (state) =>
      state.matches.flatMap((match) =>
        "botId" in match.params ? [match.params.botId] : []
      )[0] ?? "",
  });
  const { data } = useLiveQuery(
    (q) =>
      q.from({ bot: collections.bots }).where(({ bot }) => eq(bot.id, botId)),
    [botId]
  );
  const bot = data?.[0];
  const [gesture, setGesture] = useState<"welcome" | "idle" | null>("welcome");
  useEffect(() => {
    if (reduced) return;
    const welcome = window.setTimeout(() => setGesture(null), 900);
    let end = 0;
    const idle = window.setInterval(() => {
      setGesture("idle");
      end = window.setTimeout(() => setGesture(null), 600);
    }, 12_000);
    return () => {
      clearTimeout(welcome);
      clearTimeout(end);
      clearInterval(idle);
    };
  }, [reduced]);
  const mood = upgraded
    ? PROMO_MOODS.upgraded
    : excited
      ? PROMO_MOODS.excited
      : gesture && !reduced
        ? PROMO_MOODS[gesture]
        : creditMood(remaining, total);
  return (
    <motion.div
      className="shrink-0 self-center"
      data-promo-mood={mood}
      animate={
        reduced
          ? { y: 0, rotate: 0 }
          : upgraded
            ? { y: [0, -offsets.drill, 0], rotate: 0 }
            : gesture === "welcome"
              ? { rotate: [0, -9, 9, -5, 0], y: 0 }
              : { rotate: 0, y: 0 }
      }
      transition={{ duration: durations.sharedElement / 1000 }}
    >
      <BotAvatar
        look={bot ? resolveLook(bot) : defaultLook("AbacusAI")}
        mood={mood}
        size={56}
        animate={!reduced}
      />
    </motion.div>
  );
};
