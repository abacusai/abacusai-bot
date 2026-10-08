import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";

import { useChatView } from "./context";

export type ReplyTarget = NonNullable<UserTextTags["replyTo"]>;

export const composeReply = (
  text: string,
  replyTo?: ReplyTarget,
  authorName = "Assistant"
): { text: string; userText?: UserTextTags } => {
  if (!replyTo) return { text };
  const quote =
    [
      `${replyTo.role === "user" ? "You" : authorName}:`,
      ...replyTo.excerpt.split("\n"),
    ]
      .map((line) => `> ${line}`)
      .join("\n") + "\n\n";
  return {
    text: quote + text,
    userText: { replyTo, visibleFrom: quote.length },
  };
};

/**
 * The quoted message, WhatsApp/Telegram style: a 3 px accent bar, the
 * author at 12/600 and a one-line excerpt. `composer` is the preview inside
 * the composer surface (accent on the app's colours, a close button);
 * `bubble` is the card inside the sent bubble, tinted from the bubble's own
 * colours and clickable to jump to the original.
 */
export const ReplyQuote = ({
  target,
  variant = "composer",
  onCancel,
  onJump,
}: {
  target: ReplyTarget;
  variant?: "composer" | "bubble";
  onCancel?: () => void;
  onJump?: (id: string) => void;
}) => {
  const { t } = useTranslation();
  const { authorName } = useChatView();
  const author =
    target.role === "user"
      ? t("chat.actions.you")
      : (authorName ?? t("chat.actions.assistant"));
  const content = (
    <>
      <span
        className={cn(
          variant === "composer"
            ? "shrink-0 text-xs font-semibold"
            : "block truncate text-xs font-semibold",
          variant === "composer"
            ? "text-[var(--bot-accent,var(--primary))]"
            : "text-current"
        )}
      >
        {author}
      </span>
      <span
        className={cn(
          variant === "composer"
            ? "truncate text-xs"
            : "block truncate text-[13px]/snug",
          variant === "composer" ? "text-muted-foreground" : "opacity-75"
        )}
      >
        {target.excerpt.replaceAll("\n", " ")}
      </span>
    </>
  );
  return (
    <div
      data-slot="reply-quote"
      data-variant={variant}
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-hidden border-s-[3px]",
        variant === "composer"
          ? "bg-muted/50 h-[30px] rounded-lg border-[var(--bot-accent,var(--primary))] ps-2.5 pe-1"
          : "mb-1.5 rounded-xl border-current bg-[color-mix(in_oklch,currentColor_10%,transparent)] px-2.5 py-1.5"
      )}
    >
      {onJump ? (
        <button
          type="button"
          className="focus-visible:ring-ring/30 min-w-0 flex-1 rounded-md text-start outline-none focus-visible:ring-2"
          aria-label={t("chat.actions.jumpToOriginal")}
          onClick={() => onJump(target.messageId)}
        >
          {content}
        </button>
      ) : (
        <div
          className={cn(
            "min-w-0 flex-1",
            variant === "composer" && "flex items-center gap-1.5"
          )}
        >
          {content}
        </div>
      )}
      {onCancel ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground shrink-0 rounded-full"
          aria-label={t("chat.actions.cancelReply")}
          onClick={onCancel}
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
};

/** Windowing and history paging are owned by the transcript. */
export const jumpToMessage = (messageId: string, threadId: string): void => {
  document.dispatchEvent(
    new CustomEvent("chat:jump-to-message", { detail: { messageId, threadId } })
  );
};
