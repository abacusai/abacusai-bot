import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

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

export const ReplyQuote = ({
  target,
  onCancel,
  onJump,
}: {
  target: ReplyTarget;
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
      <span className="font-medium">{author}</span>
      <span className="block truncate opacity-80">{target.excerpt}</span>
    </>
  );
  return (
    <div
      data-slot="reply-quote"
      className="bg-foreground/5 flex min-w-0 items-center gap-2 rounded-lg border-s-[3px] border-[var(--bot-accent,var(--primary))] px-3 py-2 text-xs"
    >
      {onJump ? (
        <button
          type="button"
          className="min-w-0 flex-1 text-start"
          aria-label={t("chat.actions.jumpToOriginal")}
          onClick={() => onJump(target.messageId)}
        >
          {content}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{content}</div>
      )}
      {onCancel ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("chat.actions.cancelReply")}
          onClick={onCancel}
        >
          <X aria-hidden />
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
