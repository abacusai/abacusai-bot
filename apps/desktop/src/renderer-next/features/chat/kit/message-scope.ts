import type { UIMessage } from "@tanstack/ai-client";
/** The message a part renders in (its role and whether it is still streaming). */
import { createContext, use } from "react";

export interface MessageScopeValue {
  id: string;
  role: "user" | "assistant" | "system";
  streaming: boolean;
  message?: UIMessage;
}

const MessageScopeContext = createContext<MessageScopeValue>({
  id: "",
  role: "assistant",
  streaming: false,
});

export const MessageScope = MessageScopeContext.Provider;
export const useMessageScope = (): MessageScopeValue =>
  use(MessageScopeContext);
