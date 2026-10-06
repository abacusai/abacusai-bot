import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import {
  isHiddenUserText,
  visibleUserText,
} from "@abacus-ai/contract/transcript/user-text";
import type { UIMessage } from "@tanstack/ai-client";

export const userMessageText = (message: UIMessage): string =>
  visibleUserText(
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join(""),
    message.metadata?.abacus?.userText as UserTextTags | undefined
  );

export const hiddenUserMessage = (message: UIMessage): boolean =>
  message.role === "user" &&
  isHiddenUserText(
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join(""),
    message.metadata?.abacus?.userText as UserTextTags | undefined
  );
