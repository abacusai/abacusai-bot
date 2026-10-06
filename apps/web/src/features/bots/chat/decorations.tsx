import type {
  TurnFeedbackInput,
  TurnFeedbackOutcome,
} from "@abacus-ai/contract/contracts";
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
import type { UIMessage } from "@tanstack/ai-client";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  DeliverablesCard,
  resolveWorkspacePath,
  type DeliverableItem,
} from "#renderer/components/file-preview";
import type { Transport } from "#renderer/data/transport";
import { stampLabel } from "#renderer/lib/bot-turns/gap-stamp";
import {
  botThreadView,
  type BotMessageView,
} from "#renderer/lib/bot-turns/turns";

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
}

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

/** The rated segment: a migrated message's v1 segment id, else its id. */
export const feedbackSegmentId = (message: UIMessage): string => {
  const segmentId = (
    message.metadata as { abacus?: { segmentId?: unknown } } | undefined
  )?.abacus?.segmentId;
  return typeof segmentId === "string" ? segmentId : message.id;
};

export const botMessageDecorations = (
  options: BotDecorationOptions
): DecorateMessage & {
  isMessageHidden(
    message: UIMessage,
    context: MessageDecorationContext
  ): boolean;
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
  const card = (items: DeliverableItem[]) => (
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
    />
  );

  const decorate: DecorateMessage = (message, context) => {
    let index = context.index;
    if (context.messages[index]?.id !== message.id)
      index = context.messages.findIndex((row) => row.id === message.id);
    if (index < 0) return null;
    const view = viewsFor(context.messages, context.runActive)[index]!;
    if (view.hidden) return { hidden: true };
    const decoration: MessageDecoration = {};
    if (view.stampBefore != null)
      decoration.before = <GapStamp at={view.stampBefore} />;
    if (view.reaction != null)
      decoration.badge = <ReactionBadge emoji={view.reaction} />;
    const feedback =
      options.feedbackEnabled && view.spoke && !view.live ? (
        <MessageFeedback
          id={`${options.sessionId}:${feedbackSegmentId(message)}`}
          send={(rating, comment) =>
            options.sendFeedback({
              sessionId: options.sessionId,
              segmentId: feedbackSegmentId(message),
              rating,
              ...(comment != null ? { comment } : {}),
              ...(options.model !== undefined ? { model: options.model } : {}),
            })
          }
        />
      ) : null;
    decoration.actions = feedback;
    if (view.deliverables != null)
      decoration.after = (
        <>{view.deliverables != null && card(view.deliverables)}</>
      );
    return decoration;
  };
  return Object.assign(decorate, {
    isMessageHidden: (
      message: UIMessage,
      context: MessageDecorationContext
    ): boolean => {
      const index =
        context.messages[context.index]?.id === message.id
          ? context.index
          : context.messages.findIndex((row) => row.id === message.id);
      return (
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
