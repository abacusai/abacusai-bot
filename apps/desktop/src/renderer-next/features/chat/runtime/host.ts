/**
 * `useThreadHost` (spec 02 §3.5): the `UseChatReturn` that
 * `createChatUI`'s kit reads, built from the session's host store. The
 * request methods map to the session (`submit`, `retry`, `cancel`); the
 * rest exist only to satisfy the type and are never called (R2-T30).
 */
import type { MultimodalContent } from "@tanstack/ai-client";
import type { UseChatReturn } from "@tanstack/ai-react";
import { useSelector } from "@tanstack/react-store";

import { withOutbox } from "./admission";
import type { ConnectionState } from "./pump";
import type { HostState, ThreadSession } from "./session";

type ConnectionStatus = UseChatReturn["connectionStatus"];

export const toConnectionStatus = (
  connection: ConnectionState
): ConnectionStatus =>
  connection === "connected"
    ? "connected"
    : connection === "error"
      ? "error"
      : "connecting";

const unsupported = (name: string) => (): never => {
  throw new Error(`chat: ${name} is not supported by the chat kit`);
};

export const toText = (content: string | MultimodalContent): string =>
  typeof content === "string"
    ? content
    : typeof content.content === "string"
      ? content.content
      : content.content
          .map((part) => (part.type === "text" ? part.content : ""))
          .join("");

export const buildThreadHost = (
  session: ThreadSession,
  s: HostState,
  activeRunId: string | null
): UseChatReturn =>
  ({
    messages: withOutbox(s.messages, s.outbox),
    subagents: s.subagents,
    queue: [],
    runId: activeRunId ?? s.outbox.at(-1)?.runId ?? null,
    isLoading: s.outbox.length > 0,
    status: s.status,
    error: undefined,
    isSubscribed: s.connection !== "error",
    connectionStatus: toConnectionStatus(s.connection),
    sessionGenerating: activeRunId !== null || s.sessionGenerating,
    interrupts: [],
    pendingInterrupts: [],
    interruptErrors: [],
    resuming: false,
    hasOlderMessages: s.hasOlderMessages,
    sendMessage: async (content) => {
      await session.submit(toText(content));
    },
    reload: async () => {
      await session.retry();
    },
    stop: () => void session.cancel(),
    loadOlderMessages: () => session.loadOlder(),
    setMessages: unsupported("setMessages"),
    append: unsupported("append"),
    addToolResult: unsupported("addToolResult"),
    addToolApprovalResponse: unsupported("addToolApprovalResponse"),
    cancelQueued: () => {},
    clear: unsupported("clear"),
    resolveInterrupts: unsupported(
      "resolveInterrupts"
    ) as UseChatReturn["resolveInterrupts"],
    cancelInterrupts: () => {},
    retryInterrupts: () => {},
    resumeInterrupts: unsupported("resumeInterrupts"),
    resumeInterruptsUnsafe: unsupported("resumeInterruptsUnsafe"),
  }) satisfies UseChatReturn;

export const useThreadHost = (session: ThreadSession): UseChatReturn => {
  const state = useSelector(session.hostStore);
  const activeRunId = useSelector(
    state.store,
    (thread) => thread.runs.active?.runId ?? null
  );
  return buildThreadHost(session, state, activeRunId);
};
