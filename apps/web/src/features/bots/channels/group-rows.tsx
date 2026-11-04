/**
 * The channels in the Bots sidebar: a "Channels" label, one row per
 * group (the members' faces, its name, the last line or who is working)
 * and "New channel".
 */
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import { useParams } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import "../bots.css";
import { AppLink } from "#renderer/lib/navigation/app-link";

import { BotFace } from "../avatar";
import { useBots } from "../data/queries";
import { groupTitle, useChannels, useChannelsLive } from "./data";

const plain = (text: string): string =>
  text
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/[*_`#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const GroupChatRows = () => {
  const { t } = useTranslation();
  useChannelsLive();
  const channels = useChannels();
  const { bots } = useBots();
  const params = useParams({ strict: false }) as { channelId?: string };
  const byId = new Map<string, BotRow>(bots.map((bot) => [bot.id, bot]));
  const nameOf = (id: string): string | null => byId.get(id)?.name ?? null;
  if (bots.length < 2 && channels.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("channels.sidebar.title")}
      className="flex flex-col gap-0.5 pb-1"
    >
      <div className="text-muted-foreground flex h-7 items-center px-2 pt-1 text-xs">
        {t("channels.sidebar.title")}
      </div>
      {channels.map((channel) => {
        const members = channel.memberBotIds
          .map((id) => byId.get(id))
          .filter((bot): bot is BotRow => bot != null);
        const title =
          groupTitle(channel, nameOf) || t("channels.sidebar.untitled");
        const line =
          channel.working.length > 0
            ? t("channels.thread.working", {
                names: channel.working
                  .map((id) => nameOf(id) ?? "")
                  .filter(Boolean)
                  .join(", "),
                count: channel.working.length,
              })
            : channel.last != null
              ? `${channel.last.author.kind === "user" ? t("channels.sidebar.you") : (nameOf(channel.last.author.botId) ?? "")}: ${plain(channel.last.text)}`
              : t("channels.sidebar.members", { count: members.length });
        const active = params.channelId === channel.id;
        return (
          <AppLink
            key={channel.id}
            to="/bots/channels/$channelId"
            params={{ channelId: channel.id }}
            transition="nav-lateral"
            aria-current={active ? "page" : undefined}
            data-slot="item"
            data-active={active || undefined}
            data-channel-row={channel.id}
            className="ui-row text-sidebar-foreground flex h-[calc(var(--bots-row-h,56px)-2px)] items-center gap-2.5 rounded-[10px] px-2 outline-none"
          >
            <GroupFace bots={members} size={36} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px] font-medium">{title}</span>
              <span
                className={
                  channel.working.length > 0
                    ? "truncate text-xs text-(--bots-running)"
                    : "text-muted-foreground truncate text-xs"
                }
              >
                {line}
              </span>
            </span>
          </AppLink>
        );
      })}
      <AppLink
        to="/bots/channels/$channelId"
        params={{ channelId: "new" }}
        transition="nav-lateral"
        data-slot="item"
        data-channel-new=""
        className="ui-row text-muted-foreground hover:text-sidebar-foreground flex h-[calc(var(--bots-row-h,56px)-2px)] items-center gap-2.5 rounded-[10px] px-2 text-[13px] outline-none"
      >
        <span className="bg-muted flex size-7 items-center justify-center rounded-full">
          <Users className="size-3.5" />
        </span>
        {t("channels.sidebar.new")}
      </AppLink>
      <div className="border-sidebar-border mx-2 mt-1 border-b" />
    </div>
  );
};

/** Up to three members' faces, overlapping. */
export const GroupFace = ({
  bots,
  size,
}: {
  bots: readonly BotRow[];
  size: number;
}) => {
  const shown = bots.slice(0, 3);
  const small = Math.round(size * 0.62);
  if (shown.length === 0) return <span style={{ width: size, height: size }} />;
  return (
    <span
      aria-hidden
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      {shown.map((bot, index) => (
        <span
          key={bot.id}
          className="ring-sidebar absolute rounded-full ring-2"
          style={{
            left:
              index === 1 ? size - small : index === 2 ? (size - small) / 2 : 0,
            top:
              index === 1 ? 0 : index === 2 ? size - small : (size - small) / 3,
            zIndex: 3 - index,
          }}
        >
          <BotFace bot={bot} size={small} interactive={false} />
        </span>
      ))}
    </span>
  );
};
