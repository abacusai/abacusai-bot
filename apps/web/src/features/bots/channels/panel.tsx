/**
 * A channel's side panel, the way a group chat's details read: the members
 * (who is answering, who leads), what the channel is for, its pinned
 * decisions, and the way to change or delete it.
 */
import type { ChannelSummary } from "@abacus-ai/contract/channels";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import { Pin, UserPlus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AppLink } from "#renderer/lib/navigation/app-link";
import { Button } from "#renderer/ui/button";

import { BotFace } from "../avatar";
import { GroupFace } from "./group-rows";

export const ChannelPanel = ({
  channel,
  members,
  title,
  onEdit,
  onUnpin,
  onDelete,
}: {
  channel: ChannelSummary;
  members: readonly BotRow[];
  title: string;
  onEdit(): void;
  onUnpin(decisionId: string): void;
  onDelete(): void;
}) => {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-4 pb-6"
      data-testid="channel-panel"
    >
      <div className="flex flex-col items-center gap-1 py-2">
        <GroupFace bots={members} size={64} />
        <h2 className="mt-1 max-w-full text-center text-base font-semibold [overflow-wrap:anywhere]">
          {title}
        </h2>
        {channel.about != null && channel.about.length > 0 && (
          <p className="text-muted-foreground max-w-full text-center text-xs [overflow-wrap:anywhere]">
            {channel.about}
          </p>
        )}
        <button
          type="button"
          data-testid="channel-panel-edit"
          onClick={onEdit}
          className="bg-secondary mt-2 rounded-full px-3 py-2 text-xs"
        >
          {t("channels.panel.edit")}
        </button>
      </div>

      <section className="flex flex-col gap-1">
        <h3 className="text-muted-foreground px-2 text-xs font-medium">
          {t("channels.panel.members", { count: members.length })}
        </h3>
        <ul className="flex flex-col">
          {members.map((bot, index) => {
            const answering = channel.answering.includes(bot.id);
            return (
              <li key={bot.id}>
                <AppLink
                  to="/bots/$botId"
                  params={{ botId: bot.id }}
                  data-channel-member={bot.id}
                  className="hover:bg-muted flex items-center gap-2.5 rounded-lg px-2 py-1.5"
                >
                  <BotFace
                    bot={bot}
                    size={28}
                    mood={answering ? "working" : undefined}
                    interactive={false}
                  />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-sm">{bot.name}</span>
                    <span
                      className={
                        answering
                          ? "truncate text-xs text-(--bots-running)"
                          : "text-muted-foreground truncate text-xs"
                      }
                    >
                      {answering ? t("channels.panel.answering") : bot.title}
                    </span>
                  </span>
                  {index === 0 && (
                    <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                      {t("channels.panel.lead")}
                    </span>
                  )}
                </AppLink>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={onEdit}
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
        >
          <span className="bg-muted flex size-7 items-center justify-center rounded-full">
            <UserPlus className="size-3.5" />
          </span>
          {t("channels.panel.addMember")}
        </button>
      </section>

      <section
        className="flex flex-col gap-1"
        data-testid="channel-panel-decisions"
      >
        <h3 className="text-muted-foreground flex items-center gap-1.5 px-2 text-xs font-medium">
          <Pin className="size-3" />
          {t("channels.panel.decisions")}
        </h3>
        {channel.decisions.length === 0 ? (
          <p className="text-muted-foreground px-2 text-xs">
            {t("channels.panel.noDecisions")}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {channel.decisions.map((decision) => (
              <li
                key={decision.id}
                className="group/decision flex items-start gap-2 rounded-lg px-2 py-1 text-sm"
              >
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {decision.text}
                </span>
                <button
                  type="button"
                  aria-label={t("channels.decisions.unpin")}
                  title={t("channels.decisions.unpin")}
                  onClick={() => onUnpin(decision.id)}
                  className="text-muted-foreground hover:text-foreground mt-0.5 opacity-0 group-hover/decision:opacity-100 focus:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-auto flex justify-center pt-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={onDelete}
        >
          {t("channels.menu.delete")}
        </Button>
      </div>
    </div>
  );
};
