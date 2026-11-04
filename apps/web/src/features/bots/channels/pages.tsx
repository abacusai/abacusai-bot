/**
 * A channel's page (its thread, pinned decisions, members, composer)
 * and the new-channel page ("To:" the bots, then the first message), the way
 * a messaging app starts a group.
 */
import type { ChannelMessage } from "@abacus-ai/contract/channels";
import {
  MAX_CHANNEL_MEMBERS,
  MIN_CHANNEL_MEMBERS,
} from "@abacus-ai/contract/channels";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import { ChevronDown, Pin, X } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";
import { Checkbox } from "#renderer/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import { Input } from "#renderer/ui/input";
import { Textarea } from "#renderer/ui/textarea";

import { BotFace } from "../avatar";
import { useBots } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import { groupTitle, useChannelThread, useChannelsLive } from "./data";
import { GroupFace } from "./group-rows";
import { GroupComposer, GroupMessages } from "./parts";

export { ChannelMarkdown, type ChannelMarkdownView } from "./parts";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Pick 2–6 bots, as checkboxes. */
const BotPicker = ({
  bots,
  selected,
  onChange,
}: {
  bots: readonly BotRow[];
  selected: readonly string[];
  onChange(ids: string[]): void;
}) => (
  <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
    {bots.map((bot) => {
      const checked = selected.includes(bot.id);
      const full = !checked && selected.length >= MAX_CHANNEL_MEMBERS;
      return (
        <label
          key={bot.id}
          className="hover:bg-muted flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-50"
        >
          <Checkbox
            checked={checked}
            disabled={full}
            onCheckedChange={(next) =>
              onChange(
                next
                  ? [...selected, bot.id]
                  : selected.filter((id) => id !== bot.id)
              )
            }
          />
          <BotFace bot={bot} size={24} interactive={false} />
          <span className="min-w-0 flex-1 truncate">{bot.name}</span>
          {bot.title.trim().length > 0 && (
            <span className="text-muted-foreground truncate text-xs">
              {bot.title}
            </span>
          )}
        </label>
      );
    })}
  </div>
);

/** The channel id that means "a new channel" (real ids are random hex). */
export const NEW_CHANNEL = "new";

/** The title bar's slot, from the route (the shell is another feature). */
export type TopBarView = ComponentType<{ children: ReactNode }>;

export const NewGroupPage = ({ TopBar }: { TopBar: TopBarView }) => {
  const { t } = useTranslation();
  const transport = useBotsTransport();
  const navigate = useAppNavigate();
  const { bots } = useBots();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = selected
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot): bot is BotRow => bot != null);
  const matches = bots.filter(
    (bot) =>
      !selected.includes(bot.id) &&
      bot.name.toLowerCase().includes(query.trim().toLowerCase())
  );
  const ready = chosen.length >= MIN_CHANNEL_MEMBERS;
  const start = (text: string): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    transport.client.channels
      .create({
        botIds: selected,
        text,
        ...(name.trim().length > 0 ? { name } : {}),
        ...(about.trim().length > 0 ? { about } : {}),
      })
      .then((channel) =>
        navigate({
          to: "/bots/channels/$channelId",
          params: { channelId: channel.id },
        })
      )
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <div data-testid="new-channel" className="flex size-full flex-col">
      <TopBar>
        <span className="text-sm font-medium">{t("channels.new.title")}</span>
      </TopBar>
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <Input
          data-testid="channel-name"
          aria-label={t("channels.new.name")}
          value={name}
          maxLength={80}
          placeholder={t("channels.new.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
          className="h-9 text-sm font-medium"
        />
        <Input
          data-testid="channel-about"
          aria-label={t("channels.new.about")}
          value={about}
          maxLength={500}
          placeholder={t("channels.new.aboutPlaceholder")}
          onChange={(event) => setAbout(event.target.value)}
          className="h-9 text-sm"
        />
      </div>
      <div className="border-b px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-sm">
            {t("channels.new.to")}
          </span>
          {chosen.map((bot) => (
            <span
              key={bot.id}
              className="bg-muted flex items-center gap-1 rounded-full py-0.5 pr-1 pl-1 text-xs"
            >
              <BotFace bot={bot} size={18} interactive={false} />
              {bot.name}
              <button
                type="button"
                aria-label={t("channels.new.remove", { name: bot.name })}
                onClick={() =>
                  setSelected(selected.filter((id) => id !== bot.id))
                }
                className="hover:text-foreground text-muted-foreground rounded-full p-0.5"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {chosen.length < MAX_CHANNEL_MEMBERS && (
            <input
              data-testid="group-to"
              aria-label={t("channels.new.search")}
              value={query}
              placeholder={t("channels.new.search")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches[0] != null) {
                  event.preventDefault();
                  setSelected([...selected, matches[0].id]);
                  setQuery("");
                }
                if (
                  event.key === "Backspace" &&
                  query.length === 0 &&
                  selected.length > 0
                )
                  setSelected(selected.slice(0, -1));
              }}
              className="placeholder:text-muted-foreground min-w-40 flex-1 bg-transparent py-1 text-sm outline-none"
            />
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {chosen.length < MAX_CHANNEL_MEMBERS &&
          matches.map((bot) => (
            <button
              key={bot.id}
              type="button"
              data-pick-bot={bot.id}
              onClick={() => {
                setSelected([...selected, bot.id]);
                setQuery("");
              }}
              className="hover:bg-muted flex w-full max-w-md items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm"
            >
              <BotFace bot={bot} size={28} interactive={false} />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              <span className="text-muted-foreground text-xs">
                {t("channels.new.add")}
              </span>
            </button>
          ))}
        {bots.length < MIN_CHANNEL_MEMBERS && (
          <p className="text-muted-foreground px-2 py-4 text-sm">
            {t("channels.new.needBots")}
          </p>
        )}
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {error != null && (
          <p role="alert" className="text-destructive pb-2 text-sm">
            {error}
          </p>
        )}
        <p className="text-muted-foreground pb-2 text-xs">
          {ready
            ? t("channels.new.hint")
            : t("channels.new.pick", { count: MIN_CHANNEL_MEMBERS })}
        </p>
        <GroupComposer
          members={chosen}
          placeholder={
            ready ? t("channels.new.placeholder") : t("channels.new.pickFirst")
          }
          working={false}
          disabled={!ready || busy}
          onSend={start}
        />
      </div>
    </div>
  );
};

export const GroupPage = ({
  channelId,
  TopBar,
}: {
  channelId: string;
  TopBar: TopBarView;
}) => {
  const { t } = useTranslation();
  const transport = useBotsTransport();
  const navigate = useAppNavigate();
  useChannelsLive();
  const thread = useChannelThread(channelId);
  const { bots } = useBots();
  const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [editing, setEditing] = useState<"details" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map<string, BotRow>(bots.map((bot) => [bot.id, bot]));
  const nameOf = (id: string): string | null => byId.get(id)?.name ?? null;
  if (thread.isError)
    return (
      <div
        role="alert"
        className="text-muted-foreground flex size-full items-center justify-center text-sm"
      >
        {t("channels.thread.gone")}
      </div>
    );
  const data = thread.data;
  if (data == null) return <div className="size-full" />;
  const { channel, messages } = data;
  const members = channel.memberBotIds
    .map((id) => byId.get(id))
    .filter((bot): bot is BotRow => bot != null);
  const title = groupTitle(channel, nameOf) || t("channels.sidebar.untitled");
  const busy = channel.working.length > 0 || channel.queued > 0;
  const act = (call: Promise<unknown>): void =>
    void call
      .then(() => setError(null))
      .catch((reason: unknown) => setError(errorText(reason)));
  const send = (text: string): void => {
    act(
      transport.client.channels.post({
        channelId,
        text,
        ...(replyTo != null ? { replyTo: replyTo.id } : {}),
      })
    );
    setReplyTo(null);
  };
  return (
    <div data-testid="channel-page" className="flex size-full flex-col">
      <TopBar>
        <button
          type="button"
          data-testid="channel-details-open"
          aria-label={t("channels.details.open", { name: title })}
          title={t("channels.details.open", { name: title })}
          onClick={() => setEditing("details")}
          className="hover:bg-muted flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5 text-start"
        >
          <GroupFace bots={members} size={24} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span
              className="truncate text-sm font-medium"
              data-testid="channel-title"
            >
              {title}
            </span>
            {channel.about != null && channel.about.length > 0 && (
              <span className="text-muted-foreground truncate text-[11px]">
                {channel.about}
              </span>
            )}
          </span>
        </button>
      </TopBar>
      {channel.decisions.length > 0 && (
        <div className="border-b px-4 py-2" data-testid="group-decisions">
          <button
            type="button"
            aria-expanded={decisionsOpen}
            onClick={() => setDecisionsOpen(!decisionsOpen)}
            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 text-xs"
          >
            <Pin className="size-3" />
            {t("channels.decisions.title")}
            <span className="bg-muted rounded-full px-1.5 text-[11px]">
              {channel.decisions.length}
            </span>
            <ChevronDown
              className={`ms-auto size-3.5 transition-transform ${decisionsOpen ? "rotate-180" : ""}`}
            />
          </button>
          {decisionsOpen && (
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto pt-1">
              {channel.decisions.map((decision) => (
                <li
                  key={decision.id}
                  className="group/decision flex items-start gap-2 text-sm"
                >
                  <span className="min-w-0 flex-1">{decision.text}</span>
                  <button
                    type="button"
                    aria-label={t("channels.decisions.unpin")}
                    title={t("channels.decisions.unpin")}
                    onClick={() =>
                      act(
                        transport.client.channels.unpin({
                          channelId,
                          decisionId: decision.id,
                        })
                      )
                    }
                    className="text-muted-foreground hover:text-foreground opacity-0 group-hover/decision:opacity-100 focus:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <p className="text-muted-foreground px-4 py-10 text-center text-sm">
              {t("channels.thread.empty", {
                names: members.map((bot) => bot.name).join(", "),
              })}
            </p>
          ) : (
            <GroupMessages
              messages={messages}
              bots={byId}
              working={channel.working}
              onReply={setReplyTo}
              onStartAgreed={(message) =>
                act(
                  transport.client.channels.startAgreed({
                    channelId,
                    messageId: message.id,
                  })
                )
              }
              onProposal={(message, create) =>
                act(
                  transport.client.channels.decideProposal({
                    channelId,
                    messageId: message.id,
                    create,
                  })
                )
              }
              onPinAll={(lines) =>
                act(
                  Promise.all(
                    lines.map((text) =>
                      transport.client.channels.pin({ channelId, text })
                    )
                  )
                )
              }
              onPin={(message) =>
                act(
                  transport.client.channels.pin({
                    channelId,
                    messageId: message.id,
                  })
                )
              }
            />
          )}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {error != null && (
          <p role="alert" className="text-destructive pb-2 text-sm">
            {error}
          </p>
        )}
        {channel.queued > 0 && (
          <p className="text-muted-foreground pb-1 text-xs">
            {t("channels.thread.queued", { count: channel.queued })}
          </p>
        )}
        <GroupComposer
          members={members}
          placeholder={t("channels.composer.placeholder", {
            names: members.map((bot) => bot.name).join(", "),
          })}
          working={busy}
          replyingTo={
            replyTo == null || replyTo.author.kind !== "bot"
              ? null
              : (nameOf(replyTo.author.botId) ?? "")
          }
          onCancelReply={() => setReplyTo(null)}
          onSend={send}
          onStop={() => act(transport.client.channels.stopAll({ channelId }))}
          autoFocus
        />
      </div>
      {editing === "details" && (
        <DetailsDialog
          bots={bots}
          channel={channel}
          placeholder={groupTitle(
            { name: "", memberBotIds: channel.memberBotIds },
            nameOf
          )}
          onClose={() => setEditing(null)}
          onSave={(change) =>
            act(transport.client.channels.update({ channelId, ...change }))
          }
          onDelete={() => setEditing("delete")}
        />
      )}
      <Dialog
        open={editing === "delete"}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("channels.delete.title", { name: title })}
            </DialogTitle>
            <DialogDescription>{t("channels.delete.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {t("channels.dialog.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setEditing(null);
                void transport.client.channels
                  .remove({ channelId })
                  .then(() => navigate({ to: "/bots" }))
                  .catch((reason: unknown) => setError(errorText(reason)));
              }}
            >
              {t("channels.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/** A channel's details: its name, purpose and members, and Delete. */
const DetailsDialog = ({
  bots,
  channel,
  placeholder,
  onClose,
  onSave,
  onDelete,
}: {
  bots: readonly BotRow[];
  channel: { name: string; about?: string; memberBotIds: string[] };
  placeholder: string;
  onClose(): void;
  onSave(change: { name: string; about: string; botIds: string[] }): void;
  onDelete(): void;
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState(channel.name);
  const [about, setAbout] = useState(channel.about ?? "");
  const [selected, setSelected] = useState<string[]>([...channel.memberBotIds]);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="channel-details">
        <DialogHeader>
          <DialogTitle>{t("channels.details.title")}</DialogTitle>
        </DialogHeader>
        <Input
          aria-label={t("channels.new.name")}
          value={name}
          placeholder={placeholder}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <Textarea
          aria-label={t("channels.new.about")}
          value={about}
          placeholder={t("channels.new.aboutPlaceholder")}
          maxLength={500}
          onChange={(event) => setAbout(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          {t("channels.members.body", {
            min: MIN_CHANNEL_MEMBERS,
            max: MAX_CHANNEL_MEMBERS,
          })}
        </p>
        <BotPicker bots={bots} selected={selected} onChange={setSelected} />
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={onDelete}
          >
            {t("channels.menu.delete")}
          </Button>
          <span className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("channels.dialog.cancel")}
            </Button>
            <Button
              disabled={selected.length < MIN_CHANNEL_MEMBERS}
              onClick={() => {
                onSave({ name, about, botIds: selected });
                onClose();
              }}
            >
              {t("channels.dialog.save")}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
