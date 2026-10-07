import { eq, useLiveQuery } from "@tanstack/react-db";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import type { ExpressionMix } from "#renderer/components/bot-avatar/expression";
import { useCollections } from "#renderer/data/db";
import {
  defaultLook,
  resolveLook,
  type AvatarMood,
} from "#renderer/lib/bots/avatar";
import { useMotionPreference } from "#renderer/lib/motion";
export const creditExpression = (
  remaining: number | null,
  total: number | null
): ExpressionMix =>
  remaining === 0
    ? "tiredHappy"
    : remaining != null &&
        total != null &&
        total > 0 &&
        remaining / total <= 0.1
      ? "worried"
      : "hopeful";

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
  const element = useRef<HTMLDivElement>(null);
  const greeted = useRef(false);
  const [reaction, setReaction] = useState<"happy" | "wink" | null>(null);
  useEffect(() => {
    if (reduced || excited || upgraded || remaining === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    const clear = () => {
      clearTimeout(timer);
      setReaction(null);
    };
    const wink = () => {
      setReaction("wink");
      timer = setTimeout(() => {
        setReaction(null);
        timer = setTimeout(wink, 30_000);
      }, 600);
    };
    const observe = () => {
      const admitted = Boolean(
        element.current?.querySelector('[data-slot="bot-avatar"][data-animate]')
      );
      if (admitted === active) return;
      active = admitted;
      clear();
      if (!active) return;
      if (!greeted.current) {
        greeted.current = true;
        setReaction("happy");
        timer = setTimeout(() => {
          setReaction(null);
          timer = setTimeout(wink, 30_000);
        }, 600);
      } else timer = setTimeout(wink, 30_000);
    };
    const observer = new MutationObserver(observe);
    if (element.current)
      observer.observe(element.current, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-animate"],
      });
    observe();
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [reduced, excited, upgraded, remaining]);
  const collections = useCollections();
  const botId = useRouterState({
    select: (state) =>
      state.matches.flatMap((match) =>
        "botId" in match.params ? [match.params.botId] : []
      )[0] ?? "",
  });
  const { data } = useLiveQuery({
    query: (q) =>
      botId
        ? q
            .from({ bot: collections.bots })
            .where(({ bot }) => eq(bot.id, botId))
            .findOne()
        : undefined,
  });
  const bot = data;
  const reactionMood = reduced ? null : reaction;
  const mood: AvatarMood = upgraded
    ? "happy"
    : excited
      ? "excited"
      : remaining === 0
        ? "asleep"
        : (reactionMood ?? "idle");
  const expression = upgraded
    ? "proud"
    : excited || reactionMood === "wink"
      ? undefined
      : creditExpression(remaining, total);
  return (
    <div
      ref={element}
      className="shrink-0 self-center"
      data-promo-mood={mood}
      data-promo-expression={expression}
    >
      <BotAvatar
        look={bot ? resolveLook(bot) : defaultLook("AbacusAI")}
        mood={mood}
        expression={expression}
        size={56}
        animate={!reduced}
      />
    </div>
  );
};
