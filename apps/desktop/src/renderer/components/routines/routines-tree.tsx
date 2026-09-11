import { useNavigate } from "@tanstack/react-router";
import { CalendarClock, MessageCircle, Plus } from "lucide-react";
import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { BotSenderChat } from "#shared/contracts";
import type { RoutineListItem } from "#shared/routines";

import { useBotSenderChatsQuery, useBotsQuery } from "../../hooks/use-bots";
import {
  useRoutinesEventSync,
  useRoutinesQuery,
} from "../../hooks/use-routines";
import { useSessionTurnStateQuery } from "../../hooks/use-workspace-queries";
import { useSidebarConversationRoute } from "../../lib/sidebar-conversation-route";
import { useSidebarAccordion } from "../../stores/sidebar-accordion-store";
import {
  SIDEBAR_SCROLLER_ATTR,
  useScrollIntoSection,
} from "../layout/sidebar-scroll";
import { SidebarSectionLabel } from "../layout/sidebar-section-label";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";

/**
 * What runs on its own, as the sidebar's first section: routines and the chats
 * a bot answers automatically. Both open to a page of what happened.
 */

/** The sidebar id of an auto-reply chat: its session, marked as one. */
export const autoReplyRoutineId = (sessionId: string): string =>
  `chat:${sessionId}`;

export const autoReplySessionId = (routineId: string): string | null =>
  routineId.startsWith("chat:") ? routineId.slice("chat:".length) : null;

export const RoutinesTree = (): JSX.Element | null => {
  const { t } = useTranslation();
  useRoutinesEventSync();
  const routines = useRoutinesQuery().data ?? [];
  const senderChats = useBotSenderChatsQuery().data ?? [];
  const bots = useBotsQuery().data ?? [];
  const activeRoute = useSidebarConversationRoute();
  const navigate = useNavigate();
  const isOpen = useSidebarAccordion(
    (state) => state.openSection === "routines"
  );
  const toggleSection = useSidebarAccordion((state) => state.toggleSection);

  // Only chats with a standing grant: a sender the user never approved is
  // not something that runs on its own.
  const autoReplies = useMemo(
    () => senderChats.filter((chat) => chat.autoReply != null),
    [senderChats]
  );
  const botName = (botId: string): string =>
    bots.find((bot) => bot.id === botId)?.name ?? "";

  const open = (routineId: string): void => {
    void navigate({ to: "/routines/$routineId", params: { routineId } });
  };

  const count = routines.length + autoReplies.length;

  // Nothing until something runs on its own; empty sections disclose nothing.

  if (count === 0) return null;

  return (
    <SidebarGroup
      className={
        isOpen ? "flex min-h-0 flex-initial flex-col" : "min-h-0 shrink-0"
      }
      data-id="routines-list"
    >
      <SidebarSectionLabel
        label={t("routines.title")}
        count={count}
        isOpen={isOpen}
        onToggle={() => toggleSection("routines")}
        dataId="routines-section"
        action={
          <SidebarGroupAction
            data-id="new-routine-sidebar-btn"
            onClick={() => void navigate({ to: "/settings/jobs" })}
            aria-label={t("routines.newRoutine")}
            title={t("routines.newRoutine")}
          >
            <Plus />
          </SidebarGroupAction>
        }
      />
      {isOpen && (
        <SidebarGroupContent
          className="scrollbar-autohide min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-id="routines-scroller"
          {...{ [SIDEBAR_SCROLLER_ATTR]: "" }}
        >
          <div className="pb-2">
            <SidebarMenu>
              {routines.map((routine) => (
                <RoutineRow
                  key={routine.id}
                  routine={routine}
                  isActive={
                    activeRoute?.kind === "routine" &&
                    activeRoute.id === routine.id
                  }
                  onOpen={() => open(routine.id)}
                />
              ))}
              {autoReplies.map((chat) => (
                <AutoReplyRow
                  key={chat.sessionId}
                  chat={chat}
                  bot={botName(chat.botId)}
                  isActive={
                    activeRoute?.kind === "routine" &&
                    activeRoute.id === autoReplyRoutineId(chat.sessionId)
                  }
                  onOpen={() => open(autoReplyRoutineId(chat.sessionId))}
                />
              ))}
            </SidebarMenu>
          </div>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
};

const RoutineRow = ({
  routine,
  isActive,
  onOpen,
}: {
  routine: RoutineListItem;
  isActive: boolean;
  onOpen: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const rowRef = useScrollIntoSection<HTMLLIElement>(isActive);
  return (
    <SidebarMenuItem ref={rowRef}>
      <SidebarMenuButton
        onClick={onOpen}
        isActive={isActive}
        data-id={`routine-item-${routine.id}`}
        className={`h-auto py-1.5 ${routine.enabled ? "" : "opacity-60"}`}
        title={routine.enabled ? routine.name : t("routines.pausedTitle")}
      >
        <CalendarClock className="text-muted-foreground shrink-0" />
        <span className="min-w-0 flex-1 truncate text-start">
          {routine.name}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

const AutoReplyRow = ({
  chat,
  bot,
  isActive,
  onOpen,
}: {
  chat: BotSenderChat;
  bot: string;
  isActive: boolean;
  onOpen: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const isWorking =
    useSessionTurnStateQuery(chat.workspaceId, chat.sessionId).data?.isBusy ===
    true;
  const rowRef = useScrollIntoSection<HTMLLIElement>(isActive);
  return (
    <SidebarMenuItem ref={rowRef}>
      <SidebarMenuButton
        onClick={onOpen}
        isActive={isActive}
        data-id={`auto-reply-item-${chat.sessionId}`}
        className={`h-auto py-1.5 ${chat.autoReply === "paused" ? "opacity-60" : ""}`}
        title={t("routines.autoReplyRowTitle", {
          bot,
          sender: chat.senderName,
          platform: chat.platform,
        })}
      >
        <MessageCircle className="text-muted-foreground shrink-0" />
        <span className="min-w-0 flex-1 truncate text-start">
          {chat.senderName}
          <span className="text-muted-foreground"> · {chat.platform}</span>
        </span>
        {isWorking && (
          <span className="bg-primary size-1.5 shrink-0 animate-pulse rounded-full" />
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};
