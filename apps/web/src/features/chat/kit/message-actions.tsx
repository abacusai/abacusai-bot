import { MESSAGE_REACTION_EMOJIS } from "@abacus-ai/contract/message-reactions";
import type { UIMessage } from "@tanstack/ai-client";
import { Copy, Reply, SmilePlus } from "lucide-react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { useMotionPreference } from "#renderer/lib/motion";
import { BubbleReactions } from "#renderer/ui/bubble";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "#renderer/ui/context-menu";
import { Popover, PopoverTrigger, PopoverContent } from "#renderer/ui/popover";

import { updateDraft } from "../composer/draft-store";
import { actionBarTransition } from "../motion";
import { useChatView } from "./context";
import type { ReplyTarget } from "./reply";

export const messageMarkdown = (message: UIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("");

export const MessageActions = ({
  message,
  text = messageMarkdown(message),
  feedback,
  children,
}: {
  message: UIMessage;
  text?: string;
  feedback?: ReactNode;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const { threadId, session, composer, skin } = useChatView();
  const preference = useMotionPreference();
  const reduce = preference === "reduced";
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const show = !dismissed && (hovered || focused || revealed || menuOpen);
  const reactions: Array<(typeof MESSAGE_REACTION_EMOJIS)[number]> =
    message.metadata?.abacus?.reactions ?? [];
  const readOnly = composer.readOnly != null;
  const reply = () => {
    const replyTo: ReplyTarget = {
      messageId: message.id,
      role: message.role === "user" ? "user" : "assistant",
      excerpt: text.slice(0, 80),
    };
    updateDraft(threadId, (draft) => ({ ...draft, replyTo }));
    document
      .querySelector<HTMLTextAreaElement>(
        `[data-continuity-id="composer:${CSS.escape(threadId)}"]`
      )
      ?.focus();
  };
  const react = (emoji: (typeof MESSAGE_REACTION_EMOJIS)[number]) => {
    setError(false);
    setPending(true);
    void session
      .react(message.id, emoji, !reactions.includes(emoji))
      .catch(() => setError(true))
      .finally(() => setPending(false));
  };
  const reactionButton = (emoji: (typeof MESSAGE_REACTION_EMOJIS)[number]) => (
    <Button
      key={emoji}
      variant={reactions.includes(emoji) ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={t("chat.actions.react", { emoji })}
      aria-pressed={reactions.includes(emoji)}
      disabled={readOnly || pending}
      onClick={() => react(emoji)}
    >
      <span aria-hidden>{emoji}</span>
    </Button>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        className={cn("flex min-w-0", message.role === "user" && "justify-end")}
      >
        <div
          data-slot="message-actions-host"
          data-message-target={message.id}
          tabIndex={0}
          className={cn(
            "focus-visible:ring-ring relative min-w-[min(100%,320px)] rounded-lg outline-none focus-visible:ring-2",
            message.role === "user"
              ? "w-fit max-w-full self-end"
              : "w-fit max-w-full"
          )}
          onMouseEnter={() => {
            setHovered(true);
            setDismissed(false);
          }}
          onMouseLeave={() => {
            setHovered(false);
          }}
          onFocusCapture={() => {
            setFocused(true);
            setDismissed(false);
          }}
          onBlurCapture={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setFocused(false);
          }}
          onClick={(event) => {
            if (
              window.matchMedia("(max-width: 799px)").matches &&
              !(event.target as HTMLElement).closest("button,a,input,textarea")
            ) {
              setRevealed((value) => !value);
              setDismissed(revealed);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setDismissed(true);
              setRevealed(false);
              setMenuOpen(false);
            }
          }}
        >
          {children}
          <motion.div
            data-slot="message-actions"
            aria-label={t("chat.actions.label")}
            role="toolbar"
            className={cn(
              "bg-popover text-popover-foreground absolute -top-3 z-10 flex max-w-full flex-wrap items-center gap-0.5 rounded-full border p-1 shadow-sm has-[[aria-expanded=true]]:pointer-events-auto! has-[[aria-expanded=true]]:transform-none! has-[[aria-expanded=true]]:opacity-100!",
              message.role === "user"
                ? "start-0 origin-bottom-left"
                : "end-0 origin-bottom-right"
            )}
            initial={false}
            animate={{
              opacity: show ? 1 : 0,
              transform: reduce ? "none" : `scale(${show ? 1 : 0.96})`,
            }}
            transition={actionBarTransition(preference)}
            style={{ pointerEvents: show ? "auto" : "none" }}
          >
            {MESSAGE_REACTION_EMOJIS.slice(0, 5).map(reactionButton)}
            <Popover onOpenChange={setMenuOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("chat.actions.moreReactions")}
                  />
                }
              >
                <SmilePlus aria-hidden />
              </PopoverTrigger>
              <PopoverContent
                className="grid w-fit grid-cols-5 gap-1"
                side="top"
              >
                {MESSAGE_REACTION_EMOJIS.map(reactionButton)}
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.actions.reply")}
              onClick={reply}
              disabled={readOnly}
            >
              <Reply aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.actions.copy")}
              onClick={() => {
                void navigator.clipboard
                  .writeText(text)
                  .catch(() => setError(true));
              }}
            >
              <Copy aria-hidden />
            </Button>
            {feedback}
          </motion.div>
          {skin === "session" && message.role === "assistant" ? (
            <MessageReactionPills message={message} />
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {t("chat.actions.failed")}
            </p>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem disabled={readOnly} onClick={reply}>
            <Reply aria-hidden />
            {t("chat.actions.reply")}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
};

/** User pills occupy the opposite corner from the bot's ReactionBadge. */
export const MessageReactionPills = ({ message }: { message: UIMessage }) => {
  const { t } = useTranslation();
  const { session, composer } = useChatView();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const reactions: Array<(typeof MESSAGE_REACTION_EMOJIS)[number]> =
    message.metadata?.abacus?.reactions ?? [];
  if (!reactions.length) return null;
  return (
    <>
      <BubbleReactions align={message.role === "user" ? "start" : "end"}>
        {reactions.map((emoji) => (
          <Button
            key={emoji}
            variant="ghost"
            size="sm"
            aria-label={t("chat.actions.removeReaction", { emoji })}
            aria-pressed
            disabled={composer.readOnly != null || pending}
            onClick={() => {
              setPending(true);
              setFailed(false);
              void session
                .react(message.id, emoji, false)
                .catch(() => setFailed(true))
                .finally(() => setPending(false));
            }}
          >
            {emoji}
          </Button>
        ))}
      </BubbleReactions>
      {failed ? (
        <p role="alert" className="text-destructive text-xs">
          {t("chat.actions.failed")}
        </p>
      ) : null}
    </>
  );
};
