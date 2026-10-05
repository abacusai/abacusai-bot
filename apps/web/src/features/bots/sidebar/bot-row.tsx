/**
 * One sidebar row (spec 03 §7.3, canvas `BotsSidebar`): 56 px, avatar 36
 * with the attention mood, name + stamp, a secondary line that always says
 * in words what colour also says, and the unread dot or needs-you count.
 * The row, its context menu and its ⋯ menu share one item list (§7.4).
 */
import "../bots.css";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import type { TFunction } from "i18next";
import { MoreHorizontal } from "lucide-react";
import { motion, type Transition } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ACCENT_OUTLINE_CLASS } from "#renderer/components/bot-avatar";
import {
  ConnectorMark,
  markForPlatform,
} from "#renderer/components/connector-mark";
import { cn } from "#renderer/lib/cn";
import { motionFor, springs, useMotionPreference } from "#renderer/lib/motion";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#renderer/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";

import { BotFace } from "../avatar";
import { moodFor, type BotAttention } from "../data/attention";
import {
  MENU_LABEL_KEYS,
  type BotMenuItem,
  type BotMenuItemId,
} from "./bot-menu";

/** The row's secondary line and its colour (§7.3 table). */
export const secondaryLine = (
  attention: BotAttention,
  bot: Pick<BotRow, "title">,
  preview: string | null,
  t: TFunction
): { text: string; tone: "attention" | "running" | "error" | "muted" } => {
  switch (attention.kind) {
    case "needs-you":
      return {
        text:
          attention.title != null
            ? t("bots.status.needsYouTitle", { title: attention.title })
            : t("bots.status.needsYou"),
        tone: "attention",
      };
    case "routine":
      return { text: t("bots.status.checkingIn"), tone: "running" };
    case "working":
      return {
        text:
          attention.caption != null
            ? t("bots.status.workingOn", { caption: attention.caption })
            : t("bots.status.working"),
        tone: "running",
      };
    case "error":
      return { text: t("bots.status.error"), tone: "error" };
    case "paused":
      return { text: t("bots.status.paused"), tone: "muted" };
    default:
      return {
        text: preview?.trim()
          ? preview
              .replace(/```[^\n]*\n?/g, " ")
              .replace(/<\/?reply>/g, "")
              .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
              .replace(/[*_`#>~]/g, "")
              .replace(/\s+/g, " ")
              .trim()
          : bot.title,
        tone: "muted",
      };
  }
};

const TONE_CLASS = {
  attention: "text-(--bots-attention)",
  running: "text-(--bots-running)",
  error: "text-destructive",
  muted: "text-muted-foreground",
} as const;

const MenuItems = ({
  items,
  onSelect,
  kind,
}: {
  items: readonly BotMenuItem[];
  onSelect(id: BotMenuItemId): void;
  kind: "context" | "dropdown";
}) => {
  const { t } = useTranslation();
  const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
  const Separator =
    kind === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  return items.map((item) => (
    <span key={item.id} className="contents">
      {item.separated && <Separator />}
      <Item
        variant={item.destructive ? "destructive" : "default"}
        onClick={() => onSelect(item.id)}
        data-menu-item={item.id}
      >
        {t(MENU_LABEL_KEYS[item.id])}
      </Item>
    </span>
  ));
};

export const BotRowView = ({
  bot,
  attention,
  preview,
  stamp,
  active,
  hidden,
  menu,
  onMenu,
}: {
  bot: BotRow;
  attention: BotAttention;
  preview: string | null;
  stamp: string | null;
  active: boolean;
  hidden?: boolean;
  menu: readonly BotMenuItem[];
  onMenu(id: BotMenuItemId): void;
}) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const motionPref = useMotionPreference();
  const line = secondaryLine(attention, bot, preview, t);
  const mark = bot.channel != null ? markForPlatform(bot.channel) : null;
  const label = `${bot.name}, ${line.text}`;
  return (
    <motion.div
      layout={motionPref === "full" ? "position" : false}
      transition={motionFor<Transition>(motionPref, springs.sidebar, {
        duration: 0,
      })}
      hidden={hidden}
      data-bot-row={bot.id}
      className="group/row relative"
    >
      <ContextMenu>
        <ContextMenuTrigger render={<div />} className="relative">
          <AppLink
            to="/bots/$botId"
            params={{ botId: bot.id }}
            onKeyDown={(event) => {
              if (
                event.key !== "ContextMenu" &&
                !(event.key === "F10" && event.shiftKey)
              )
                return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              event.currentTarget.dispatchEvent(
                new MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: rect.left + rect.width / 2,
                  clientY: rect.top + rect.height / 2,
                  button: 2,
                })
              );
            }}
            aria-current={active ? "page" : undefined}
            aria-label={label}
            data-slot="item"
            data-active={active || undefined}
            className="text-sidebar-foreground hover:bg-sidebar-accent/60 data-active:bg-sidebar-accent focus-visible:ring-ring/50 flex h-[var(--bots-row-h,56px)] items-center gap-2.5 rounded-[10px] px-2 outline-none focus-visible:ring-2"
          >
            <BotFace
              bot={bot}
              mood={moodFor(attention)}
              size={36}
              {...(preview != null ? { title: preview } : {})}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    "truncate text-[13px] font-medium",
                    attention.kind === "paused" && "text-muted-foreground"
                  )}
                >
                  {bot.name}
                </span>
                {mark != null && <ConnectorMark id={mark} size={16} />}
                <span
                  style={{ visibility: menuOpen ? "hidden" : undefined }}
                  className="text-muted-foreground ml-auto shrink-0 text-[11px] group-focus-within/row:invisible group-hover/row:invisible [@media(hover:none)]:invisible"
                >
                  {stamp}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate text-xs", TONE_CLASS[line.tone])}>
                  {line.text}
                </span>
                {attention.kind === "needs-you" ? (
                  <span
                    aria-label={t("bots.sidebar.waiting", {
                      count: attention.count,
                    })}
                    className="bots-pop ml-auto flex size-[18px] shrink-0 items-center justify-center rounded-full bg-(--bots-attention) text-[11px] font-semibold text-(--bots-attention-foreground)"
                  >
                    {attention.count}
                  </span>
                ) : attention.kind === "unread" ? (
                  <span
                    className={cn(
                      "bots-pop ml-auto size-2 shrink-0 rounded-full bg-(--bots-attention)",
                      ACCENT_OUTLINE_CLASS
                    )}
                  >
                    <span className="sr-only">{t("bots.sidebar.unread")}</span>
                  </span>
                ) : null}
              </span>
            </span>
          </AppLink>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52 rounded-[14px]">
          <MenuItems items={menu} onSelect={onMenu} kind="context" />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("bots.sidebar.options", { name: bot.name })}
              className="bg-sidebar-accent text-muted-foreground absolute top-1.5 right-1.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-popup-open:opacity-100 [@media(hover:none)]:opacity-100"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 rounded-[14px]">
          <MenuItems items={menu} onSelect={onMenu} kind="dropdown" />
        </DropdownMenuContent>
      </DropdownMenu>
    </motion.div>
  );
};
