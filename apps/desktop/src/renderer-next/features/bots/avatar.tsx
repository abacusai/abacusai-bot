/**
 * The bots area's avatar: `BotAvatar` with the bot's resolved look (legacy
 * ids mapped at render time, §14.3), its lifecycle mood, a 600 ms reaction
 * layered on top (§14.2), and animation only under full motion (§16.4).
 */
import { Store, useSelector } from "@tanstack/react-store";
import type { CSSProperties } from "react";

import { BotAvatar } from "#next/components/bot-avatar";
import {
  resolveLook,
  type AvatarMood,
  type LifecycleMood,
  type Look,
  type LookSource,
  type ReactionMood,
} from "#next/lib/bots/avatar";
import { useMotionPreference } from "#next/lib/motion";

import { useBotActivity } from "./chat/activity";

const REACTION_MS = 600;

interface Reaction {
  mood: ReactionMood;
  until: number;
}

const reactions = new Store<Record<string, Reaction>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Layer `mood` over the bot's lifecycle for 600 ms (one per bot). */
export const react = (botId: string, mood: ReactionMood): void => {
  const until = Date.now() + REACTION_MS;
  reactions.setState((state) => ({ ...state, [botId]: { mood, until } }));
  clearTimeout(timers.get(botId));
  timers.set(
    botId,
    setTimeout(() => {
      timers.delete(botId);
      reactions.setState((state) => {
        const { [botId]: _done, ...rest } = state;
        return rest;
      });
    }, REACTION_MS)
  );
};

export const useReaction = (botId: string | null): ReactionMood | null =>
  useSelector(reactions, (state) =>
    botId == null ? null : (state[botId]?.mood ?? null)
  );

export const BotFace = ({
  bot,
  look,
  mood = "idle",
  size,
  className,
  style,
  title,
}: {
  /** The bot whose look (and reactions) to show; or pass `look`. */
  bot?: LookSource & { id: string };
  look?: Look;
  mood?: LifecycleMood | AvatarMood;
  size: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) => {
  const motion = useMotionPreference();
  const reaction = useReaction(bot?.id ?? null);
  const activity = useBotActivity(bot?.id ?? "");
  const resolved = look ?? (bot != null ? resolveLook(bot) : null);
  if (resolved == null) return null;
  return (
    <BotAvatar
      look={resolved}
      mood={
        reaction ??
        (mood === "idle" || mood === "working" ? activity.mood : null) ??
        mood
      }
      size={size}
      animate={motion === "full"}
      {...(className != null ? { className } : {})}
      {...(style != null ? { style } : {})}
      {...(title != null ? { title } : {})}
    />
  );
};
