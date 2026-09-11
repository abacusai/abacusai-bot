import { useNavigate } from "@tanstack/react-router";
import { MoreVertical, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { type Bot } from "#shared/bots";
import type { BotChatPreview } from "#shared/contracts";

import {
  useBotChatPreviewsQuery,
  useBotsEventSync,
  useBotsQuery,
  useDeleteBotMutation,
} from "../../hooks/use-bots";
import { useSessionTurnStateQuery } from "../../hooks/use-workspace-queries";
import { useSidebarConversationRoute } from "../../lib/sidebar-conversation-route";
import { useWorkspaceStore } from "../../stores/code-store";
import { useSidebarAccordion } from "../../stores/sidebar-accordion-store";
import { Dialog } from "../common/dialog";
import { chatStamp } from "../layout/session-list-utils";
import {
  SIDEBAR_SCROLLER_ATTR,
  useScrollIntoSection,
} from "../layout/sidebar-scroll";
import { SidebarSectionLabel } from "../layout/sidebar-section-label";
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { BotAvatar } from "./bot-avatar";
import { BotDialog } from "./bot-dialog";

/**
 * The bots list, the sidebar's first section. Deliberately flat: a bot is
 * someone you talk to, not a place you file things, so no per-workspace
 * grouping. Opening a bot resolves its forever chat in the main process and
 * activates it exactly like clicking a session.
 */
export const BotsTree = (): JSX.Element => {
  const { t } = useTranslation();
  const activeRoute = useSidebarConversationRoute();
  useBotsEventSync();

  const botsQuery = useBotsQuery();
  const previews = useBotChatPreviewsQuery().data ?? {};
  const pinnedBotIds = useWorkspaceStore((state) => state.pinnedBotIds);
  const toggleBotPinned = useWorkspaceStore((state) => state.toggleBotPinned);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  // Ages are drawn to the minute, so re-render on that cadence.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const bots = useMemo(
    () => [...(botsQuery.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [botsQuery.data]
  );
  // Pinned first, each group newest-first. An id whose bot is gone renders
  // nothing and falls away on the next unpin.
  const pinnedBots = useMemo(
    () => bots.filter((bot) => pinnedBotIds.includes(bot.id)),
    [bots, pinnedBotIds]
  );
  const restBots = useMemo(
    () => bots.filter((bot) => !pinnedBotIds.includes(bot.id)),
    [bots, pinnedBotIds]
  );

  const deleteMutation = useDeleteBotMutation();
  const navigate = useNavigate();
  const setNewPaneIntent = useWorkspaceStore((state) => state.setNewPaneIntent);

  const [dialogState, setDialogState] = useState<{
    open: boolean;
    bot: Bot | null;
  }>({ open: false, bot: null });
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const isOpen = useSidebarAccordion((state) => state.openSection === "bots");
  const toggleSection = useSidebarAccordion((state) => state.toggleSection);

  /**
   * The maker is the empty pane itself, and clearing the active session puts
   * it back on screen. A dialog asked for a mission before the bot had a name.
   */
  const startNewBot = (): void => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    setNewPaneIntent("bot");
    // Navigate first, and unconditionally: which pane is on screen is route
    // state, and the activator only navigates when it activated something,
    // which with no workspace yet is nothing.
    void navigate({ to: "/bots/new" });
    if (workspaceId != null) {
      useWorkspaceStore.getState().setActiveSessionId(workspaceId, null);
    }
  };

  const openBot = (botId: string): void => {
    void navigate({ to: "/bots/$botId", params: { botId } });
  };

  // Auto-reply conversations are listed under Routines; the row is the bot alone.
  const renderBot = (bot: Bot): JSX.Element => {
    return (
      <div key={bot.id}>
        <BotRow
          bot={bot}
          isActive={activeRoute?.kind === "bot" && activeRoute.id === bot.id}
          onOpen={() => void openBot(bot.id)}
          onEdit={() => setDialogState({ open: true, bot })}
          onDelete={() => setDeleteTarget(bot)}
          onTogglePin={() => toggleBotPinned(bot.id)}
          isPinned={pinnedBotIds.includes(bot.id)}
          preview={previews[bot.id]}
          now={now}
        />
      </div>
    );
  };

  return (
    <div
      className={
        isOpen ? "flex min-h-0 flex-initial flex-col" : "flex shrink-0 flex-col"
      }
    >
      <SidebarGroup
        className={
          isOpen ? "flex min-h-0 flex-initial flex-col" : "min-h-0 shrink-0"
        }
      >
        <SidebarSectionLabel
          label={t("bots.title")}
          count={bots.length}
          isOpen={isOpen}
          onToggle={() => toggleSection("bots")}
          dataId="bots-section"
          action={
            <SidebarGroupAction
              data-id="new-bot-btn"
              onClick={startNewBot}
              aria-label={t("bots.newBot")}
              title={t("bots.newBot")}
            >
              <Plus />
            </SidebarGroupAction>
          }
        />
        {isOpen && (
          <SidebarGroupContent
            className="scrollbar-autohide min-h-0 flex-1 overflow-y-auto overscroll-contain"
            data-id="bots-scroller"
            {...{ [SIDEBAR_SCROLLER_ATTR]: "" }}
          >
            <div className="pb-1">
              {bots.length === 0 ? (
                <Empty className="py-6">
                  <EmptyHeader>
                    <EmptyTitle>{t("bots.emptyTitle")}</EmptyTitle>
                    <EmptyDescription>
                      {t("bots.emptyDescription")}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button
                      size="sm"
                      data-id="new-bot-empty-state"
                      onClick={startNewBot}
                    >
                      <Plus />
                      {t("bots.newBot")}
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <SidebarMenu>
                  {pinnedBots.length > 0 && (
                    <>
                      <SidebarSectionLabel
                        label={t("bots.pinned")}
                        count={pinnedBots.length}
                        isOpen={pinnedOpen}
                        onToggle={() => setPinnedOpen((open) => !open)}
                        dataId="bots-pinned"
                      />
                      {pinnedOpen && pinnedBots.map(renderBot)}
                    </>
                  )}
                  {restBots.map(renderBot)}
                </SidebarMenu>
              )}
            </div>
          </SidebarGroupContent>
        )}
      </SidebarGroup>

      <BotDialog
        isOpen={dialogState.open}
        bot={dialogState.bot}
        onClose={() => setDialogState({ open: false, bot: null })}
      />

      <Dialog
        isOpen={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        icon={Trash2}
        title={t("bots.deleteTitle")}
        data-id="delete-bot-dialog"
        buttons={[
          {
            label: t("bots.cancel"),
            variant: "secondary",
            onClick: () => setDeleteTarget(null),
          },
          {
            label: t("bots.delete"),
            variant: "destructive",
            onClick: async () => {
              const target = deleteTarget;
              if (target == null) return true;
              try {
                await deleteMutation.mutateAsync(target.id);
              } catch {
                return t("bots.deleteError");
              }
              setDeleteTarget(null);
              return true;
            },
          },
        ]}
      >
        <p className="text-muted-foreground text-sm">
          {t("bots.deleteBody", { name: deleteTarget?.name ?? "" })}
        </p>
      </Dialog>
    </div>
  );
};

/** "1:25 PM" today, "Yesterday" before that, then the weekday, then a date. */
const BotStamp = ({
  at,
  now,
}: {
  at: number | null | undefined;
  now: number;
}): JSX.Element | null => {
  const { t, i18n } = useTranslation();
  const stamp = chatStamp(at, now);
  if (stamp == null || at == null) return null;

  const when = new Date(at);
  const label =
    stamp.kind === "time"
      ? when.toLocaleTimeString(i18n.language, {
          hour: "numeric",
          minute: "2-digit",
        })
      : stamp.kind === "yesterday"
        ? t("workspace.yesterday")
        : new Intl.DateTimeFormat(
            i18n.language,
            stamp.kind === "weekday"
              ? { weekday: "long" }
              : {
                  month: "short",
                  day: "numeric",
                  ...(stamp.sameYear ? {} : { year: "numeric" }),
                }
          ).format(when);

  return (
    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
      {label}
    </span>
  );
};

const BotRow = ({
  bot,
  isActive,
  onOpen,
  onEdit,
  onDelete,
  onTogglePin,
  isPinned,
  preview,
  now,
}: {
  bot: Bot;
  isActive: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  isPinned: boolean;
  /** The last line said in this bot's chat, when it has said anything. */
  preview?: BotChatPreview;
  now: number;
}): JSX.Element => {
  const { t } = useTranslation();
  // The green "finished while you were away" dot, same signal sessions use.
  const hasUnread = useWorkspaceStore((state) =>
    bot.sessionId != null
      ? state.isSessionCompletedInBackground(bot.sessionId)
      : false
  );
  const isWorking =
    useSessionTurnStateQuery(bot.workspaceId, bot.sessionId).data?.isBusy ===
    true;
  const rowRef = useScrollIntoSection<HTMLLIElement>(isActive);

  return (
    <SidebarMenuItem ref={rowRef}>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuButton
              onClick={onOpen}
              isActive={isActive}
              data-id={`bot-item-${bot.id}`}
              className="h-auto py-1.5"
            />
          }
        >
          <BotAvatar
            seed={`${bot.id}:${bot.name}`}
            color={bot.avatarColor}
            shape={bot.avatarShape}
            size={24}
            active={isWorking}
            className="shrink-0"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-start">
                {bot.name}
              </span>
              <BotStamp at={preview?.at} now={now} />
            </span>
            {/* The last thing said, not the role label: it is why you would
                open the row. Falls back to the title. */}
            <span className="text-muted-foreground min-w-0 truncate text-start text-xs">
              {preview != null && preview.text.length > 0
                ? preview.text
                : bot.title}
            </span>
          </span>
          {isPinned && (
            <Pin
              className="text-muted-foreground size-3 shrink-0"
              aria-hidden
            />
          )}
          {hasUnread && (
            <span className="size-1.5 shrink-0 rounded-full bg-green-400" />
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onTogglePin} data-id={`bot-pin-${bot.id}`}>
            {isPinned ? <PinOff /> : <Pin />}
            {isPinned ? t("bots.unpin") : t("bots.pin")}
          </ContextMenuItem>
          {/* Channel bots mirror the Discord/Telegram chat and are made and
              retired by linking, never by hand. */}
          {bot.channel == null && (
            <ContextMenuItem onClick={onEdit} data-id={`bot-edit-${bot.id}`}>
              <Pencil />
              {t("bots.editBot")}
            </ContextMenuItem>
          )}
          {bot.channel == null && (
            <ContextMenuItem
              variant="destructive"
              onClick={onDelete}
              data-id={`bot-delete-${bot.id}`}
            >
              <Trash2 />
              {t("bots.deleteBot")}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* The right-click menu's two actions on a control the user can see:
          a context menu is not an affordance. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              showOnHover
              // A bot row is two lines and the action's default pins to the
              // first; the peer-data variant must be restated or it wins.
              className="top-1/2 -translate-y-1/2 peer-data-[size=default]/menu-button:top-1/2"
              data-id={`bot-menu-${bot.id}`}
              aria-label={t("bots.botOptions")}
              title={t("bots.botOptions")}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <MoreVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4}>
          <DropdownMenuItem
            onClick={onTogglePin}
            data-id={`bot-menu-pin-${bot.id}`}
          >
            {isPinned ? <PinOff /> : <Pin />}
            {isPinned ? t("bots.unpin") : t("bots.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onEdit}
            data-id={`bot-menu-edit-${bot.id}`}
          >
            <Pencil />
            {t("bots.editBot")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={onDelete}
            data-id={`bot-menu-delete-${bot.id}`}
          >
            <Trash2 />
            {t("bots.deleteBot")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
};
