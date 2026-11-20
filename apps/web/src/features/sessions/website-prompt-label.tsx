/**
 * The chat the website's prompt started (lib/website-prompt.ts): its first
 * message carries a small "Your task from the website" line, so the person
 * sees the app is doing what they asked for there and not something of its
 * own. While it runs the line offers Stop; after, Edit puts the words back in
 * the box to change and send again. Drawn by wrapping the route's
 * `decorateMessage`, like the continuation links.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Decorate } from "#renderer/components/run-report";

export interface WebsitePromptActions {
  stop(): void;
  edit(text: string): void;
}

/** The message's own words, as the box would hold them. */
export const messageText = (message: UIMessage): string =>
  message.parts
    .map((part) =>
      part.type === "text" ? (part as { content: string }).content : ""
    )
    .join("")
    .trim();

const WebsitePromptLine = ({
  running,
  onStop,
  onEdit,
}: {
  running: boolean;
  onStop(): void;
  onEdit(): void;
}) => {
  const { t } = useTranslation();
  return (
    <div
      data-slot="website-prompt"
      className="text-muted-foreground mx-auto my-2 flex w-full max-w-[min(640px,90%)] items-center justify-end gap-1.5 text-xs"
    >
      <Globe aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {t("sessions.websitePrompt.label")}
      </span>
      <span aria-hidden>·</span>
      {running ? (
        <button
          type="button"
          data-action="stop-website-prompt"
          className="shrink-0 font-medium underline"
          onClick={onStop}
        >
          {t("sessions.websitePrompt.stop")}
        </button>
      ) : (
        <button
          type="button"
          data-action="edit-website-prompt"
          className="shrink-0 font-medium underline"
          onClick={onEdit}
        >
          {t("sessions.websitePrompt.edit")}
        </button>
      )}
    </div>
  );
};

/** `decorate` with the website line above the chat's first message of the person's. */
export const withWebsitePrompt = (
  decorate: Decorate,
  actions: WebsitePromptActions | null
): Decorate => {
  if (actions == null) return decorate;
  return (message, context) => {
    const inner = decorate(message, context);
    if (inner?.hidden === true || message.role !== "user") return inner;
    const first = context.messages.find((row) => row.role === "user");
    if (first?.id !== message.id) return inner;
    return {
      ...inner,
      before: (
        <>
          {inner?.before}
          <WebsitePromptLine
            running={context.runActive}
            onStop={actions.stop}
            onEdit={() => actions.edit(messageText(message))}
          />
        </>
      ),
    };
  };
};
