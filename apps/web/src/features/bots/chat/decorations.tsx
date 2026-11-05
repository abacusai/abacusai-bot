import type { BotExchangeTag } from "@abacus-ai/contract/agent-types";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import type {
  TurnFeedbackInput,
  TurnFeedbackOutcome,
} from "@abacus-ai/contract/contracts";
import { feedbackSegmentId } from "@abacus-ai/contract/transcript/feedback-target";
import type { UIMessage } from "@tanstack/ai-client";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
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
  if (quoted != null) return quoted.trim();
  if (outcome === "failed")
    return (
      /could not (?:finish|answer)[^:]*: ([^\n]*)/.exec(text)?.[1]?.trim() ?? ""
    );
  return "";
};

/**
 * A bot-to-bot note as a row (the way a group chat shows "messaged X"):
 * the other bot's face and what happened, opening to the exchange.
 */
const ExchangeRow = ({
  message,
  exchange,
  bots,
}: {
  message: UIMessage;
  exchange: BotExchangeTag;
  bots: readonly BotRow[];
}) => {
  const { t } = useTranslation();
  const other = bots.find((bot) => bot.id === exchange.botId);
  const name = other?.name ?? exchange.bot;
  const title =
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
  const body = exchangeBody(message, exchange.outcome);
  return (
    <div
      data-slot="bot-exchange"
      data-outcome={exchange.outcome}
      className="py-1"
    >
      <Collapsible>
        <CollapsibleTrigger className="group/x text-muted-foreground hover:text-foreground flex items-center gap-2 text-xs">
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-data-[panel-open]/x:rotate-90"
          />
          {other != null && <BotFace bot={other} size={20} />}
          <span className="truncate">{title}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 ml-5 flex max-w-[min(640px,85%)] flex-col gap-2 text-sm">
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
        </CollapsibleContent>
      </Collapsible>
    </div>
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
    const exchange = exchangeOf(message);
    // The note itself draws nothing (hidden user text); the row stands in.
    if (exchange != null)
      return {
        before: (
          <ExchangeRow
            message={message}
            exchange={exchange}
            bots={options.bots ?? []}
          />
        ),
      };
    const view = viewsFor(context.messages, context.runActive)[index]!;
    if (view.hidden) return { hidden: true };
    const decoration: MessageDecoration = {};
    if (view.stampBefore != null)
      decoration.before = <GapStamp at={view.stampBefore} />;
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
      return (
        exchangeOf(message) == null &&
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
