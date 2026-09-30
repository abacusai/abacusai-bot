import { findCheckIn } from "#next/lib/bots/check-in";
/**
 * `botAttention` over live data (spec 03 §6.6): the bot's sessions, its
 * check-in, main's per-thread asks, pending connector asks and unread. One
 * hook for the row, the strip, the title bar and the avatar mood.
 */
import type { BotRow, RoutineRow, SessionRow } from "#shared/contract/rows";

import {
  useAllBotActivity,
  useBotActivity,
  type BotActivity,
} from "../chat/activity";
import {
  botAttention,
  type BotAttention,
  type ThreadAttention,
} from "./attention";
import { useConnectorAsks, usePermissions } from "./live";
import { botSessionsOf, useAllRoutines, useAllSessions } from "./queries";
import { useUnreadIds } from "./unread-store";

export interface AttentionSources {
  activities?: Readonly<Record<string, BotActivity>>;
  sessions: readonly SessionRow[];
  routines: readonly RoutineRow[];
  permissions: Readonly<Record<string, ThreadAttention>>;
  asks: Readonly<Record<string, number>>;
  unread: ReadonlySet<string>;
}

/** Every source once, for lists that compute many bots' attention. */
export const useAttentionSources = (): AttentionSources => ({
  activities: useAllBotActivity(),
  sessions: useAllSessions(),
  routines: useAllRoutines(),
  permissions: usePermissions(),
  asks: useConnectorAsks(),
  unread: useUnreadIds(),
});

export const attentionOf = (
  bot: Pick<BotRow, "id">,
  sources: AttentionSources,
  runningTool: string | null = null
): BotAttention => {
  const checkIn = findCheckIn(sources.routines, bot.id);
  return botAttention({
    sessions: botSessionsOf(sources.sessions, bot.id, checkIn?.id ?? null),
    checkInRoutineId: checkIn?.id ?? null,
    permissions: sources.permissions,
    connectorAsks: sources.asks,
    unread: sources.unread.has(bot.id),
    checkIn: checkIn == null ? null : { enabled: checkIn.enabled },
    runningTool:
      runningTool ?? sources.activities?.[bot.id]?.runningTool ?? null,
  });
};

export const useBotAttention = (
  bot: Pick<BotRow, "id">,
  runningTool: string | null = null
): BotAttention => {
  const activity = useBotActivity(bot.id);
  return attentionOf(
    bot,
    useAttentionSources(),
    runningTool ?? activity.runningTool
  );
};
