/**
 * A bot's menu (spec 03 §7.4): one item list for the row's context menu,
 * its ⋯ button and the 800 px title-bar menu, so they never disagree
 * (parity P22). Channel bots get Pin and Mark as unread only.
 */
import { useTranslation } from "react-i18next";

import { useDb } from "#next/data/db";
import { usePrefs } from "#next/data/db/prefs";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { toast } from "#next/ui/toast";
import { MAX_BOTS } from "#shared/bots";
import type { BotRow, RoutineRow } from "#shared/contract/rows";

import {
  duplicateBot,
  setCheckInsEnabled,
  setPinned,
} from "../data/bot-actions";
import { botsUnreadStore } from "../data/unread-store";

export type BotMenuItemId =
  | "pin"
  | "unpin"
  | "mark-unread"
  | "edit"
  | "duplicate"
  | "pause-check-ins"
  | "resume-check-ins"
  | "delete";

export interface BotMenuItem {
  id: BotMenuItemId;
  /** A separator goes before this item. */
  separated: boolean;
  destructive: boolean;
}

/** Pure: which items a bot's menu shows (R3-T14). */
export const botMenuItems = (input: {
  channel: boolean;
  pinned: boolean;
  unread: boolean;
  botCount: number;
  checkIn: { enabled: boolean } | null;
}): BotMenuItem[] => {
  const items: BotMenuItem[] = [];
  const add = (id: BotMenuItemId, separated = false, destructive = false) =>
    items.push({ id, separated, destructive });
  add(input.pinned ? "unpin" : "pin");
  if (!input.unread) add("mark-unread");
  if (input.channel) return items;
  add("edit");
  if (input.botCount < MAX_BOTS) add("duplicate");
  if (input.checkIn != null)
    add(input.checkIn.enabled ? "pause-check-ins" : "resume-check-ins", true);
  add("delete", true, true);
  return items;
};

export const MENU_LABEL_KEYS: Record<BotMenuItemId, string> = {
  pin: "bots.sidebar.pin",
  unpin: "bots.sidebar.unpin",
  "mark-unread": "bots.sidebar.markUnread",
  edit: "bots.sidebar.edit",
  duplicate: "bots.sidebar.duplicate",
  "pause-check-ins": "bots.sidebar.pauseCheckIns",
  "resume-check-ins": "bots.sidebar.resumeCheckIns",
  delete: "bots.sidebar.delete",
};

/** Runs a menu item; `onDelete` opens the confirmation (§7.5). */
export const useBotMenuActions = (
  bot: BotRow,
  context: {
    checkIn: RoutineRow | null;
    allBots: readonly BotRow[];
    onDelete(bot: BotRow): void;
  }
) => {
  const { t } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const navigate = useAppNavigate();
  const fail = (key: string) => toast.add({ title: t(key), type: "error" });
  return (id: BotMenuItemId): void => {
    switch (id) {
      case "pin":
      case "unpin":
        void setPinned(db, prefs.pinned.botIds, bot.id, id === "pin").catch(
          () => fail("bots.errors.pin")
        );
        return;
      case "mark-unread":
        botsUnreadStore.mark(bot.id);
        return;
      case "edit":
        void navigate({
          to: "/bots/$botId/edit",
          params: { botId: bot.id },
          transition: "nav-forward",
        });
        return;
      case "duplicate":
        void duplicateBot(db.collections.bots, bot, context.allBots).catch(() =>
          fail("bots.errors.duplicate")
        );
        return;
      case "pause-check-ins":
      case "resume-check-ins":
        if (context.checkIn != null)
          void setCheckInsEnabled(
            db.collections.routines,
            context.checkIn,
            id === "resume-check-ins"
          ).catch(() => fail("bots.errors.checkIn"));
        return;
      case "delete":
        context.onDelete(bot);
        return;
    }
  };
};
