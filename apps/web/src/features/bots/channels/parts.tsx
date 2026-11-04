/**
 * The pieces of a channel: the members' stacked faces, the message list
 * (each bot's face, name and colour), the "working" faces and the composer
 * with @-mentions of the members.
 */
import {
  agreedItems,
  type ChannelBotProposal,
  type ChannelMessage,
  type ChannelWork,
} from "@abacus-ai/contract/channels";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import {
  ArrowUp,
  CircleAlert,
  CircleCheck,
  CircleStop,
  LoaderCircle,
  Pin,
  Play,
  CornerUpLeft,
  Square,
  UserPlus,
} from "lucide-react";
import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  type ComponentType,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { accentVars, resolveLook } from "#renderer/lib/bots/avatar";
import { cn } from "#renderer/lib/cn";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { platformSystem } from "#renderer/lib/platform-system";
import { Button } from "#renderer/ui/button";

import { BotFace } from "../avatar";
import { useBotsTransport } from "../data/transport";

/**
 * How a message's Markdown is drawn: the route passes the chat's renderer
 * (a feature may not import another feature's internals); plain text until.
 */
export type ChannelMarkdownView = ComponentType<{
  text: string;
  role: "user" | "assistant";
  openExternal(url: string): void;
}>;
const PlainText: ChannelMarkdownView = ({ text }) => (
  <p className="whitespace-pre-wrap">{text}</p>
);
export const ChannelMarkdown = createContext<ChannelMarkdownView>(PlainText);

/** The chat's prose styles, for the bubbles (chat.css loads with the chat view only). */
const PROSE =
  "[&_ol]:list-decimal [&_ol]:ps-5 [&_ul]:list-disc [&_ul]:ps-5 [&_li+li]:mt-1 [&_p+*]:mt-2 [&_ul+*]:mt-2 [&_ol+*]:mt-2 [&_a]:underline";

const time = (at: number, language: string): string =>
  new Date(at).toLocaleTimeString(language, {
    hour: "numeric",
    minute: "2-digit",
  });

export const GroupMessages = ({
  messages,
  bots,
  working,
  onReply,
  onPin,
  onPinAll,
  onProposal,
  onStartAgreed,
}: {
  messages: readonly ChannelMessage[];
  bots: ReadonlyMap<string, BotRow>;
  working: readonly string[];
  onReply(message: ChannelMessage): void;
  onPin(message: ChannelMessage): void;
  /** Pin several lines at once (a discussion's agreed points). */
  onPinAll?(lines: string[]): void;
  /** The user starts a discussion's agreed items as work. */
  onStartAgreed?(message: ChannelMessage): void;
  /** The user creates or dismisses a bot a message proposed. */
  onProposal?(message: ChannelMessage, create: boolean): void;
}) => {
  const { t, i18n } = useTranslation();
  const transport = useBotsTransport();
  const end = useRef<HTMLDivElement | null>(null);
  const GroupMarkdown = useContext(ChannelMarkdown);
  const openExternal = (url: string): void =>
    void platformSystem(transport.client).openExternal({ url });
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, working.length]);
  return (
    <div
      role="log"
      aria-label={t("channels.thread.label")}
      className="flex flex-col gap-3 px-4 py-4"
    >
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        if (message.author.kind === "user")
          return (
            <div
              key={message.id}
              className="group/msg flex flex-col items-end gap-1"
            >
              <div
                className={`bg-primary text-primary-foreground max-w-[min(560px,85%)] rounded-[20px] rounded-br-md px-3.5 py-2 text-sm ${PROSE}`}
              >
                <Suspense
                  fallback={
                    <p className="whitespace-pre-wrap">{message.text}</p>
                  }
                >
                  <GroupMarkdown
                    text={message.text}
                    role="user"
                    openExternal={openExternal}
                  />
                </Suspense>
              </div>
              <MessageActions
                message={message}
                onReply={null}
                onPin={onPin}
                stamp={time(message.at, i18n.language)}
              />
            </div>
          );
        const bot = bots.get(message.author.botId);
        const sameAuthor =
          previous?.author.kind === "bot" &&
          previous.author.botId === message.author.botId;
        return (
          <div
            key={message.id}
            data-group-message={message.author.botId}
            className="group/msg flex items-start gap-2.5"
            style={bot != null ? accentVars(resolveLook(bot)) : undefined}
          >
            <span className="w-8 shrink-0 pt-5">
              {!sameAuthor && bot != null && (
                <BotFace bot={bot} size={32} interactive={false} />
              )}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              {!sameAuthor && (
                <span className="text-xs font-medium text-(--bot-accent,var(--muted-foreground))">
                  {bot?.name ?? t("channels.thread.goneBot")}
                </span>
              )}
              <div
                className={cn(
                  PROSE,
                  "max-w-[min(620px,90%)] rounded-[20px] rounded-bl-md bg-[var(--chat-surface,var(--muted))] px-3.5 py-2 text-sm",
                  message.failed && "text-muted-foreground italic"
                )}
              >
                <Suspense
                  fallback={
                    <p className="whitespace-pre-wrap">{message.text}</p>
                  }
                >
                  <GroupMarkdown
                    text={message.text}
                    role="assistant"
                    openExternal={openExternal}
                  />
                </Suspense>
              </div>
              <Mentioned
                text={message.text}
                bots={bots}
                self={message.author.botId}
              />
              {message.conclusion === true &&
                message.planStarted !== true &&
                onStartAgreed != null && (
                  <button
                    type="button"
                    data-testid="start-agreed"
                    onClick={() => onStartAgreed(message)}
                    className="flex w-fit items-center gap-1 text-xs font-medium text-(--bot-accent,var(--primary)) hover:underline"
                  >
                    <Play className="size-3.5" />
                    {t("channels.thread.startAgreed")}
                  </button>
                )}
              {message.conclusion === true && onPinAll != null && (
                <button
                  type="button"
                  data-testid="pin-conclusion"
                  onClick={() => onPinAll(agreedItems(message.text))}
                  className="flex w-fit items-center gap-1 text-xs text-(--bot-accent,var(--primary)) hover:underline"
                >
                  <Pin className="size-3.5" />
                  {t("channels.thread.pinAgreed")}
                </button>
              )}
              {message.proposal != null && onProposal != null && (
                <ProposalCard
                  proposal={message.proposal}
                  onDecide={(create) => onProposal(message, create)}
                />
              )}
              {message.work != null && bot != null && (
                <WorkCard work={message.work} bot={bot} />
              )}
              <MessageActions
                message={message}
                onReply={message.failed ? null : onReply}
                onPin={onPin}
                stamp={time(message.at, i18n.language)}
              />
            </div>
          </div>
        );
      })}
      {working.length > 0 && (
        <div
          className="text-muted-foreground flex items-center gap-2 pl-10 text-xs"
          aria-live="polite"
        >
          <span className="flex -space-x-1.5">
            {working.map((id) => {
              const bot = bots.get(id);
              return bot == null ? null : (
                <BotFace
                  key={id}
                  bot={bot}
                  mood="working"
                  size={20}
                  interactive={false}
                />
              );
            })}
          </span>
          {t("channels.thread.working", {
            names: working
              .map((id) => bots.get(id)?.name ?? "")
              .filter(Boolean)
              .join(", "),
            count: working.length,
          })}
        </div>
      )}
      <div ref={end} />
    </div>
  );
};

/** The members a message @mentions, as faces that open their own chat. */
const Mentioned = ({
  text,
  bots,
  self,
}: {
  text: string;
  bots: ReadonlyMap<string, BotRow>;
  self: string;
}) => {
  const { t } = useTranslation();
  const lower = text.toLowerCase();
  const named = [...bots.values()].filter(
    (bot) => bot.id !== self && lower.includes(`@${bot.name.toLowerCase()}`)
  );
  if (named.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {named.map((bot) => (
        <AppLink
          key={bot.id}
          to="/bots/$botId"
          params={{ botId: bot.id }}
          title={t("channels.work.open", { name: bot.name })}
          className="bg-muted hover:bg-accent flex items-center gap-1 rounded-full py-0.5 pr-2 pl-0.5 text-[11px]"
          style={accentVars(resolveLook(bot))}
        >
          <BotFace bot={bot} size={16} interactive={false} />
          <span className="text-(--bot-accent,var(--foreground))">
            @{bot.name}
          </span>
        </AppLink>
      ))}
    </div>
  );
};

/** A new bot a bot proposed: the user creates it (and it joins) or not. */
const ProposalCard = ({
  proposal,
  onDecide,
}: {
  proposal: ChannelBotProposal;
  onDecide(create: boolean): void;
}) => {
  const { t } = useTranslation();
  return (
    <div
      data-channel-proposal={proposal.status}
      className="flex max-w-[min(620px,90%)] flex-col gap-1.5 rounded-xl border border-dashed px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <UserPlus className="size-3.5" />
        {t(
          proposal.invite === true
            ? "channels.proposal.inviteTitle"
            : "channels.proposal.title",
          { name: proposal.name }
        )}
        {proposal.title.length > 0 && (
          <span className="text-muted-foreground font-normal">
            · {proposal.title}
          </span>
        )}
      </div>
      <p className="text-muted-foreground">{proposal.mission}</p>
      {proposal.status === "proposed" ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            data-testid="proposal-create"
            onClick={() => onDecide(true)}
          >
            {t(
              proposal.invite === true
                ? "channels.proposal.add"
                : "channels.proposal.create"
            )}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDecide(false)}>
            {t("channels.proposal.dismiss")}
          </Button>
        </div>
      ) : proposal.status === "created" && proposal.botId != null ? (
        <AppLink
          to="/bots/$botId"
          params={{ botId: proposal.botId }}
          className="w-fit text-(--bot-accent,var(--primary)) hover:underline"
        >
          {t(
            proposal.invite === true
              ? "channels.proposal.added"
              : "channels.proposal.created",
            { name: proposal.name }
          )}
        </AppLink>
      ) : (
        <span className="text-muted-foreground italic">
          {t("channels.proposal.dismissed")}
        </span>
      )}
    </div>
  );
};

/** Work a bot took to its own chat: what, how it is going, and a way there. */
const WorkCard = ({ work, bot }: { work: ChannelWork; bot: BotRow }) => {
  const { t } = useTranslation();
  const Icon =
    work.status === "running"
      ? LoaderCircle
      : work.status === "done"
        ? CircleCheck
        : work.status === "stopped"
          ? CircleStop
          : CircleAlert;
  return (
    <div
      data-channel-work={work.status}
      className={cn(
        "flex max-w-[min(620px,90%)] flex-col gap-1 rounded-xl border px-3 py-2 text-xs",
        work.status === "failed" && "border-destructive/40"
      )}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            work.status === "running" && "animate-spin text-(--bots-running)",
            work.status === "done" && "text-(--bot-accent,var(--primary))",
            work.status === "failed" && "text-destructive"
          )}
        />
        {t(`channels.work.${work.status}`, { name: bot.name })}
      </div>
      <p className="text-muted-foreground">{work.task}</p>
      {work.error != null && work.status !== "done" && (
        <p className="text-muted-foreground italic">{work.error}</p>
      )}
      <AppLink
        to="/bots/$botId"
        params={{ botId: bot.id }}
        className="w-fit text-(--bot-accent,var(--primary)) underline-offset-2 hover:underline"
      >
        {t("channels.work.open", { name: bot.name })}
      </AppLink>
    </div>
  );
};

const MessageActions = ({
  message,
  onReply,
  onPin,
  stamp,
}: {
  message: ChannelMessage;
  onReply: ((message: ChannelMessage) => void) | null;
  onPin(message: ChannelMessage): void;
  stamp: string;
}) => {
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex h-5 items-center gap-1 text-[11px]">
      <span>{stamp}</span>
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100">
        {onReply != null && (
          <button
            type="button"
            aria-label={t("channels.thread.reply")}
            title={t("channels.thread.reply")}
            onClick={() => onReply(message)}
            className="hover:text-foreground rounded p-0.5"
          >
            <CornerUpLeft className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label={t("channels.thread.pin")}
          title={t("channels.thread.pin")}
          onClick={() => onPin(message)}
          className="hover:text-foreground rounded p-0.5"
        >
          <Pin className="size-3.5" />
        </button>
      </span>
    </div>
  );
};

/** The `@word` being typed at the caret, if any. */
export const mentionAt = (
  text: string,
  caret: number
): { start: number; query: string } | null => {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\p{L}\p{N}_ -]{0,30})$/u.exec(before);
  if (match == null) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
};

export const GroupComposer = ({
  members,
  placeholder,
  working,
  replyingTo,
  onCancelReply,
  onSend,
  onStop,
  autoFocus = false,
  disabled = false,
}: {
  members: readonly BotRow[];
  placeholder: string;
  working: boolean;
  replyingTo?: string | null;
  onCancelReply?(): void;
  onSend(text: string): void;
  onStop?(): void;
  autoFocus?: boolean;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const mention = mentionAt(text, caret);
  const options =
    mention == null
      ? []
      : [
          ...members.map((bot) => bot.name),
          // The host reads "@everyone" literally, in any language.
          "everyone",
        ].filter((name) =>
          name.toLowerCase().startsWith(mention.query.toLowerCase().trimStart())
        );
  const pick = (name: string): void => {
    if (mention == null) return;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    const at = mention.start + name.length + 2;
    setText(next);
    setCaret(at);
    setHighlight(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };
  const send = (): void => {
    const value = text.trim();
    if (value.length === 0 || disabled) return;
    onSend(value);
    setText("");
    setCaret(0);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (options.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((highlight + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(options[highlight] ?? options[0]!);
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send();
    }
  };
  return (
    <div className="relative">
      {options.length > 0 && (
        <div
          role="listbox"
          aria-label={t("channels.composer.mentions")}
          className="bg-popover text-popover-foreground absolute bottom-full left-2 mb-1 w-56 overflow-hidden rounded-lg border p-1 shadow-md"
        >
          {options.map((name, index) => {
            const bot = members.find((member) => member.name === name);
            return (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={index === highlight}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(name);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  index === highlight && "bg-accent"
                )}
              >
                {bot != null ? (
                  <BotFace bot={bot} size={20} interactive={false} />
                ) : (
                  <span className="w-5 text-center">@</span>
                )}
                {name}
              </button>
            );
          })}
        </div>
      )}
      {replyingTo != null && (
        <div className="text-muted-foreground flex items-center gap-2 px-3 pb-1 text-xs">
          <CornerUpLeft className="size-3.5" />
          <span className="truncate">
            {t("channels.composer.replyingTo", { name: replyingTo })}
          </span>
          <button
            type="button"
            onClick={onCancelReply}
            className="hover:text-foreground underline"
          >
            {t("channels.composer.cancelReply")}
          </button>
        </div>
      )}
      <div className="bg-muted/60 focus-within:ring-ring/30 flex items-end gap-2 rounded-[22px] border px-3 py-2 focus-within:ring-2">
        <textarea
          ref={area}
          data-testid="group-composer"
          aria-label={t("channels.composer.label")}
          rows={1}
          autoFocus={autoFocus}
          value={text}
          placeholder={placeholder}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setHighlight(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKey}
          className="placeholder:text-muted-foreground field-sizing-content max-h-48 min-h-6 flex-1 resize-none bg-transparent py-1 text-sm outline-none"
        />
        {working && onStop != null ? (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            aria-label={t("channels.composer.stop")}
            title={t("channels.composer.stop")}
            onClick={onStop}
            className="size-8 shrink-0 rounded-full"
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          aria-label={t("channels.composer.send")}
          title={t("channels.composer.send")}
          disabled={disabled || text.trim().length === 0}
          onClick={send}
          className="size-8 shrink-0 rounded-full"
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
};
