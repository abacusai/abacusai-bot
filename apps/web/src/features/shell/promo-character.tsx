import { eq, useLiveQuery } from "@tanstack/react-db";
import { useRouterState } from "@tanstack/react-router";

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
  const mood: AvatarMood = upgraded
    ? "happy"
    : excited
      ? "excited"
      : remaining === 0
        ? "asleep"
        : "idle";
  const expression = upgraded
    ? "proud"
    : excited
      ? undefined
      : creditExpression(remaining, total);
  return (
    <div
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
