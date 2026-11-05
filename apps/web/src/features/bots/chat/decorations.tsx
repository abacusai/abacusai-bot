import type {
  BotExchangeTag,
  BotTaskTag,
} from "@abacus-ai/contract/agent-types";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import type {
  TurnFeedbackInput,
  TurnFeedbackOutcome,
} from "@abacus-ai/contract/contracts";
import { feedbackSegmentId } from "@abacus-ai/contract/transcript/feedback-target";
import type { UIMessage } from "@tanstack/ai-client";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  DeliverablesCard,
  resolveWorkspacePath,
  type DeliverableItem,
} from "#renderer/components/file-preview";
/**
 * The bot skin's message decorations (spec 03 §11.3, §11.3a), handed to the
 * chat kit's `slots.decorateMessage`: silent turns and suppressed or held
 * emoji replies hidden, the reaction badge on the user message, one
 * deliverables card after the turn's last shown message, 15-minute gap
 * stamps, and feedback on completed replies. The turn derivation
 * (`lib/bot-turns`) runs once per messages array, not per message.
 *
 * Features do not import each other, so the slot's types are declared here
 * structurally (identical to the kit's).
 */
import { ShareRowButton } from "#renderer/components/share/share-row-button";
import type { Transport } from "#renderer/data/transport";
import { stampLabel } from "#renderer/lib/bot-turns/gap-stamp";
import {
  botThreadView,
  type BotMessageView,
} from "#renderer/lib/bot-turns/turns";
import { AppLink } from "#renderer/lib/navigation/app-link";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";

import { BotFace } from "../avatar";
import { MessageFeedback } from "./feedback";

export interface MessageDecorationContext {
  messages: readonly UIMessage[];
  index: number;
  runActive: boolean;
}

interface MessageDecoration {
  hidden?: boolean;
  before?: ReactNode;
  after?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}

export type DecorateMessage = (
  message: UIMessage,
  context: MessageDecorationContext
) => MessageDecoration | null;

export interface BotDecorationOptions {
  sessionId: string;
  /** The session's model, sent with feedback. */
  model?: string | null;
  /** An Abacus.AI account exists (`account.abacus`); else no controls. */
  feedbackEnabled: boolean;
  sendFeedback(input: TurnFeedbackInput): Promise<TurnFeedbackOutcome>;
  /** The viewed session's workspace root; relative paths resolve against it. */
  workspaceRoot: string | null;
  /** Open a file (absolute after resolution) in the read-only preview. */
  onOpenFile(absPath: string): void;
  /** Open a URL in the bot's browser tab. */
  onOpenUrl(url: string): void;
  /** "Open in browser": the system browser. */
  onOpenExternal(url: string): void;
  /** "Show in folder". */
  onReveal?(absPath: string): void;
  /** The user's bots, for the face on a bot-to-bot row. */
  bots?: readonly BotRow[];
}

/** A request to another bot in an assistant message: the tool call's bot and words. */
const requestsOf = (
  message: UIMessage
): Array<{ kind: "ask" | "task"; bot: string; what: string }> =>
  message.role !== "assistant"
    ? []
    : message.parts.flatMap((part) => {
        if (part.type !== "tool-call") return [];
        const name = (part as { name?: string }).name;
        if (name !== "ask_bot" && name !== "give_task_to_bot") return [];
        const input = ((part as { input?: unknown }).input ?? {}) as Record<
          string,
          unknown
        >;
        const raw = name === "ask_bot" ? input.request : input.task;
        const what = (typeof raw === "string" ? raw : "")
          .replace(/\s+/g, " ")
          .trim();
        return [
          {
            kind: name === "ask_bot" ? ("ask" as const) : ("task" as const),
            bot: typeof input.bot === "string" ? input.bot : "",
            what: what.length > 90 ? `${what.slice(0, 89)}…` : what,
          },
        ];
      });

/** A small centred line between messages, the way a group chat notes "messaged X". */
const ROW_TRIGGER =
  "text-muted-foreground hover:text-foreground mx-auto flex items-center gap-1.5 text-xs";
const ROW_BODY =
  "bg-muted/40 mx-auto mt-2 flex w-full max-w-[min(640px,90%)] flex-col gap-2 rounded-md p-3 text-sm";

/** The bots named in a list, in the reader's language ("Planner and Researcher"), each with its face. */
const BotList = ({
  names,
  bots,
  language,
}: {
  names: readonly string[];
  bots: readonly BotRow[];
  language: string;
}) => {
  const parts = new Intl.ListFormat(language, {
    type: "conjunction",
  }).formatToParts([...names]);
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "literal")
          return <Fragment key={index}>{part.value}</Fragment>;
        const bot = bots.find(
          (row) => row.name.toLowerCase() === part.value.toLowerCase()
        );
        return (
          <span key={index} className="inline-flex items-center gap-1">
            {bot != null && <BotFace bot={bot} size={18} />}
            <span className="truncate">{bot?.name ?? part.value}</span>
          </span>
        );
      })}
    </>
  );
};

/**
 * "Messaged {face} Planner and {face} Researcher": one row for the turn's
 * requests to other bots, opening to what each was asked.
 */
const RequestRows = ({
  requests,
  bots,
}: {
  requests: ReadonlyArray<{ kind: "ask" | "task"; bot: string; what: string }>;
  bots: readonly BotRow[];
}) => {
  const { t, i18n } = useTranslation();
  const names = [...new Set(requests.map((request) => request.bot))];
  return (
    <Collapsible
      className="flex flex-col py-1"
      data-slot="bot-requests"
      data-count={requests.length}
    >
      <CollapsibleTrigger className={ROW_TRIGGER}>
        <span>{t("bots.chat.exchange.messaged")}</span>
        <BotList names={names} bots={bots} language={i18n.language} />
      </CollapsibleTrigger>
      <CollapsibleContent className={ROW_BODY}>
        {requests.map((request, index) => {
          const other = bots.find(
            (bot) => bot.name.toLowerCase() === request.bot.toLowerCase()
          );
          return (
            <div
              key={index}
              className="flex flex-col gap-1"
              data-slot="bot-request"
              data-kind={request.kind}
            >
              {names.length > 1 && (
                <div className="flex items-center gap-1.5 font-medium">
                  {other != null && <BotFace bot={other} size={16} />}
                  {other?.name ?? request.bot}
                </div>
              )}
              <div>
                <span className="text-muted-foreground">
                  {t(
                    request.kind === "task"
                      ? "bots.chat.exchange.task"
                      : "bots.chat.exchange.asked"
                  )}{" "}
                </span>
                <span className="whitespace-pre-wrap">{request.what}</span>
              </div>
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
};

/** The task another bot passed on, if the prompt is one. */
const taskOf = (message: UIMessage): BotTaskTag | null => {
  if (message.role !== "user") return null;
  const operator = (
    message.metadata as
      | {
          abacus?: {
            userText?: { operator?: { kind?: string; task?: BotTaskTag } };
          };
        }
      | undefined
  )?.abacus?.userText?.operator;
  return operator?.kind === "bot-task" && operator.task != null
    ? operator.task
    : null;
};

/**
 * A task passed on by another bot, where its prompt sits: the user's own
 * words as their message, headed by who passed it on, and the task as that
 * bot wrote it underneath.
 */
const TaskCard = ({
  task,
  bots,
}: {
  task: BotTaskTag;
  bots: readonly BotRow[];
}) => {
  const { t } = useTranslation();
  const passer = bots.find((bot) => bot.id === task.passerId);
  const name = passer?.name ?? task.passer;
  const same = task.userWords.trim() === task.task.trim();
  return (
    <div
      className="flex flex-col items-end gap-1 py-1"
      data-slot="bot-task"
      data-ask={task.askId}
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {passer != null && <BotFace bot={passer} size={16} />}
        <span>{t("bots.chat.task.from", { bot: name })}</span>
      </div>
      <div className="w-fit max-w-[min(640px,85%)] rounded-[20px] rounded-br-md bg-[var(--bot-accent,var(--primary))] px-3 py-2 text-sm whitespace-pre-wrap text-[var(--bot-accent-foreground,var(--primary-foreground))]">
        {task.userWords}
      </div>
      {!same && (
        <Collapsible className="flex flex-col items-end">
          <CollapsibleTrigger className={ROW_TRIGGER}>
            {t("bots.chat.task.asWritten", { bot: name })}
          </CollapsibleTrigger>
          <CollapsibleContent className="text-muted-foreground mt-1 max-w-[min(640px,85%)] text-xs whitespace-pre-wrap">
            {task.task}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};

/** The bot-to-bot exchange a hidden note carries, if it is one. */
export const exchangeOf = (message: UIMessage): BotExchangeTag | null => {
  if (message.role !== "user") return null;
  const operator = (
    message.metadata as
      | {
          abacus?: {
            userText?: {
              operator?: { kind?: string; exchange?: BotExchangeTag };
            };
          };
        }
      | undefined
  )?.abacus?.userText?.operator;
  return operator?.kind === "bot-exchange" && operator.exchange != null
    ? operator.exchange
    : null;
};

/** Markdown marks dropped: the row is plain text, not a Markdown surface. */
const plainWords = (text: string): string =>
  text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();

/** The other bot's words inside the note, and why it failed if it did. */
const exchangeBody = (
  message: UIMessage,
  outcome: BotExchangeTag["outcome"]
): string => {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");
  const quoted = /<bot_reply[^>]*>([\s\S]*?)<\/bot_reply>/.exec(text)?.[1];
  if (quoted != null) return plainWords(quoted);
  if (outcome === "failed")
    return (
      /could not (?:finish|answer)[^:]*: ([^\n]*)/.exec(text)?.[1]?.trim() ?? ""
    );
  return "";
};

interface Exchange {
  message: UIMessage;
  exchange: BotExchangeTag;
}

const exchangeTitle = (
  exchange: BotExchangeTag,
  name: string,
  t: (key: string, values: Record<string, string>) => string
): string =>
  exchange.outcome === "follow-up"
    ? t("bots.chat.exchange.followUp", { bot: name })
    : exchange.outcome === "failed"
      ? t(
          exchange.kind === "task"
            ? "bots.chat.exchange.taskFailed"
            : "bots.chat.exchange.askFailed",
          { bot: name }
        )
      : t(
          exchange.kind === "task"
            ? "bots.chat.exchange.taskDone"
            : "bots.chat.exchange.answered",
          { bot: name }
        );

/** What passed in one exchange: the request, the user's words, the reply, the chat. */
const ExchangeDetails = ({
  message,
  exchange,
  name,
  title,
}: Exchange & { name: string; title?: string }) => {
  const { t } = useTranslation();
  const body = exchangeBody(message, exchange.outcome);
  return (
    <div className="flex flex-col gap-2" data-slot="bot-exchange-details">
      {title != null && <div className="font-medium">{title}</div>}
      <div>
        <span className="text-muted-foreground">
          {t(
            exchange.kind === "task"
              ? "bots.chat.exchange.task"
              : "bots.chat.exchange.asked"
          )}{" "}
        </span>
        <span className="whitespace-pre-wrap">{exchange.request}</span>
      </div>
      {exchange.userWords != null && (
        <div>
          <span className="text-muted-foreground">
            {t("bots.chat.exchange.userWrote", { bot: name })}{" "}
          </span>
          <span className="whitespace-pre-wrap">{exchange.userWords}</span>
        </div>
      )}
      {body !== "" && (
        <div className="whitespace-pre-wrap" data-slot="bot-exchange-body">
          {body}
        </div>
      )}
      {exchange.chatSessionId != null && (
        <AppLink
          to="/bots/$botId/chats/$sessionId"
          params={{
            botId: exchange.botId,
            sessionId: exchange.chatSessionId,
          }}
          className="text-xs underline"
        >
          {t("bots.chat.exchange.open", { bot: name })}
        </AppLink>
      )}
    </div>
  );
};

/**
 * A bot-to-bot note as a small centred row (the way a group chat shows
 * "messaged X"): the other bot's face and what happened, opening to the
 * exchange.
 */
const ExchangeRow = ({
  message,
  exchange,
  bots,
}: Exchange & { bots: readonly BotRow[] }) => {
  const { t } = useTranslation();
  const other = bots.find((bot) => bot.id === exchange.botId);
  const name = other?.name ?? exchange.bot;
  return (
    <Collapsible
      data-slot="bot-exchange"
      data-outcome={exchange.outcome}
      className="flex flex-col py-1"
    >
      <CollapsibleTrigger className={ROW_TRIGGER}>
        {other != null && <BotFace bot={other} size={18} />}
        <span className="truncate">{exchangeTitle(exchange, name, t)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className={ROW_BODY}>
        <ExchangeDetails message={message} exchange={exchange} name={name} />
      </CollapsibleContent>
    </Collapsible>
  );
};

/** Several exchanges in a row: "3 messages with {faces} 2 bots", opening to each. */
const FoldRow = ({
  items,
  bots,
}: {
  items: readonly Exchange[];
  bots: readonly BotRow[];
}) => {
  const { t } = useTranslation();
  const nameOf = (exchange: BotExchangeTag): string =>
    bots.find((bot) => bot.id === exchange.botId)?.name ?? exchange.bot;
  const ids = [...new Set(items.map((item) => item.exchange.botId))];
  const others = ids
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot) => bot != null);
  return (
    <Collapsible
      data-slot="bot-exchange"
      data-fold={items.length}
      className="flex flex-col py-1"
    >
      <CollapsibleTrigger className={ROW_TRIGGER}>
        <span>
          {t("bots.chat.exchange.foldMessages", { count: items.length })}
        </span>
        <span className="flex items-center -space-x-1">
          {others.map((bot) => (
            <BotFace key={bot.id} bot={bot} size={18} />
          ))}
        </span>
        <span>{t("bots.chat.exchange.foldBots", { count: ids.length })}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className={ROW_BODY}>
        {items.map((item) => (
          <ExchangeDetails
            key={item.message.id}
            message={item.message}
            exchange={item.exchange}
            name={nameOf(item.exchange)}
            title={exchangeTitle(item.exchange, nameOf(item.exchange), t)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
};

const GapStamp = ({ at }: { at: Date }) => {
  const { t, i18n } = useTranslation();
  return (
    <div
      className="text-muted-foreground py-2 text-center text-xs"
      data-slot="gap-stamp"
    >
      {stampLabel(at, new Date(), i18n.language, t("bots.chat.yesterday"))}
    </div>
  );
};

const ReactionBadge = ({ emoji }: { emoji: string }) => {
  const { t } = useTranslation();
  const label = t("bots.chat.reaction", { emoji });
  return (
    <span
      className="bg-muted ring-background rounded-full px-2 py-0.5 text-sm ring-2"
      role="img"
      aria-label={label}
      title={label}
      data-slot="reaction-badge"
    >
      {emoji}
    </span>
  );
};

export const botMessageDecorations = (
  options: BotDecorationOptions
): DecorateMessage & {
  isMessageHidden(
    message: UIMessage,
    context: MessageDecorationContext
  ): boolean;
  /** The same card, for the credits card's list of what is ready. */
  renderDeliverables(items: readonly DeliverableItem[]): ReactNode;
} => {
  const cache = new WeakMap<
    readonly UIMessage[],
    { runActive: boolean; views: BotMessageView[] }
  >();
  const viewsFor = (
    messages: readonly UIMessage[],
    runActive: boolean
  ): BotMessageView[] => {
    const hit = cache.get(messages);
    if (hit != null && hit.runActive === runActive) return hit.views;
    const views = botThreadView(messages, runActive);
    cache.set(messages, { runActive, views });
    return views;
  };

  const resolve = (path: string): string =>
    resolveWorkspacePath(path, options.workspaceRoot);
  const card = (items: readonly DeliverableItem[]) => (
    <DeliverablesCard
      items={items}
      onOpen={(item) =>
        item.isUrl
          ? options.onOpenUrl(item.path)
          : options.onOpenFile(resolve(item.path))
      }
      onReveal={
        options.onReveal
          ? (item) => options.onReveal?.(resolve(item.path))
          : undefined
      }
      onOpenUrl={(item) => options.onOpenExternal(item.path)}
      rowAction={(item) =>
        item.isUrl ? null : <ShareRowButton path={resolve(item.path)} />
      }
    />
  );

  const decorate: DecorateMessage = (message, context) => {
    let index = context.index;
    if (context.messages[index]?.id !== message.id)
      index = context.messages.findIndex((row) => row.id === message.id);
    if (index < 0) return null;
    // The skin hands over a copy with its parts stripped; the stored message
    // still has the words.
    const stored = context.messages[index] ?? message;
    const task = taskOf(stored);
    if (task != null)
      return { before: <TaskCard task={task} bots={options.bots ?? []} /> };
    const exchange = exchangeOf(stored);
    // The note itself draws nothing (hidden user text); the row stands in.
    // Notes that follow one another fold into one row at the run's end.
    if (exchange != null) {
      const next = context.messages[index + 1];
      if (next != null && exchangeOf(next) != null) return { hidden: true };
      let start = index;
      while (start > 0 && exchangeOf(context.messages[start - 1]!) != null)
        start--;
      const run = context.messages.slice(start, index + 1).flatMap((row) => {
        const tag = exchangeOf(row);
        return tag == null ? [] : [{ message: row, exchange: tag }];
      });
      return {
        before:
          run.length > 1 ? (
            <FoldRow items={run} bots={options.bots ?? []} />
          ) : (
            <ExchangeRow
              message={stored}
              exchange={exchange}
              bots={options.bots ?? []}
            />
          ),
      };
    }
    const view = viewsFor(context.messages, context.runActive)[index]!;
    const requests = requestsOf(stored);
    if (view.hidden)
      return requests.length > 0
        ? {
            hidden: true,
            before: (
              <RequestRows requests={requests} bots={options.bots ?? []} />
            ),
          }
        : { hidden: true };
    const decoration: MessageDecoration = {};
    if (view.stampBefore != null || requests.length > 0)
      decoration.before = (
        <>
          {view.stampBefore != null && <GapStamp at={view.stampBefore} />}
          {requests.length > 0 && (
            <RequestRows requests={requests} bots={options.bots ?? []} />
          )}
        </>
      );
    if (view.reaction != null)
      decoration.badge = <ReactionBadge emoji={view.reaction} />;
    // One rating per turn: the turn's last spoken reply carries it.
    const views = viewsFor(context.messages, context.runActive);
    let closesTurn = true;
    for (let next = index + 1; next < context.messages.length; next++) {
      if (context.messages[next]!.role === "user") break;
      if (views[next]!.spoke) {
        closesTurn = false;
        break;
      }
    }
    // Keyed on the stored message: the skin drops thinking and blank parts
    // from the one it shows, and the key counts the stored parts. A bubble
    // with no spoken text has nothing the server can rate.
    const segmentId = feedbackSegmentId(context.messages[index]!);
    const feedback =
      options.feedbackEnabled &&
      view.spoke &&
      !view.live &&
      closesTurn &&
      segmentId != null ? (
        <MessageFeedback
          id={`${options.sessionId}:${segmentId}`}
          send={(rating, comment) =>
            options.sendFeedback({
              sessionId: options.sessionId,
              segmentId,
              rating,
              ...(comment != null ? { comment } : {}),
              ...(options.model !== undefined ? { model: options.model } : {}),
            })
          }
        />
      ) : null;
    // Always visible under the reply, as the old bot list's rating row was.
    if (feedback != null || view.deliverables != null)
      decoration.after = (
        <>
          {feedback}
          {view.deliverables != null && card(view.deliverables)}
        </>
      );
    return decoration;
  };
  return Object.assign(decorate, {
    renderDeliverables: card,
    isMessageHidden: (
      message: UIMessage,
      context: MessageDecorationContext
    ): boolean => {
      const index =
        context.messages[context.index]?.id === message.id
          ? context.index
          : context.messages.findIndex((row) => row.id === message.id);
      // A note the chat draws as a row, or a turn that only asked another
      // bot, stays: its row is the decoration.
      const stored =
        index >= 0 ? (context.messages[index] ?? message) : message;
      return (
        exchangeOf(stored) == null &&
        taskOf(stored) == null &&
        requestsOf(stored).length === 0 &&
        index >= 0 &&
        viewsFor(context.messages, context.runActive)[index]?.hidden === true
      );
    },
  });
};

/** `agent.feedback` over the document's transport. */
export const feedbackSender =
  (transport: Transport) =>
  (input: TurnFeedbackInput): Promise<TurnFeedbackOutcome> =>
    transport.client.agent.feedback(input);
