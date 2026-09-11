/**
 * The single conversation store, keyed by session id, plus the provider that
 * binds it to the active session. Switching only re-points the provider, so a
 * background session keeps accumulating segments off-screen.
 */
import { useEffect, type JSX, type ReactNode } from "react";

import { ConversationProvider, createConversationStore } from ".";
import { restoreTranscript, startTranscriptPersistence } from "./persistence";
import { workspaceConversationTransport } from "./transport";

export const workspaceConversationStore = createConversationStore(
  workspaceConversationTransport
);

/**
 * Subscribes the store to the raw NDJSON channel for the app lifetime: main
 * broadcasts with no buffering, so an unmounting subtree would drop events.
 */
export const useWorkspaceConversationBridge = (): void => {
  useEffect(() => {
    return window.api.agent.onEvent((event) => {
      // A turn started by an incoming messaging-connector message never passed
      // through the composer, so echo the sender's words here.
      if (event.type === "messaging-user-message") {
        workspaceConversationTransport.registerSession(
          event.sessionId,
          event.workspaceId
        );
        workspaceConversationTransport.echoUserMessage(
          event.sessionId,
          event.content
        );
        return;
      }
      // Same reason, for what the turn sent: a bot transcript withholds the
      // turn's own text, so this is the answer's only echo.
      if (event.type === "messaging-agent-message") {
        workspaceConversationTransport.registerSession(
          event.sessionId,
          event.workspaceId
        );
        workspaceConversationTransport.echoAgentMessage(
          event.sessionId,
          event.content
        );
        return;
      }
      if (event.type !== "local-cli-ndjson") return;
      workspaceConversationTransport.ingest(
        event.workspaceId,
        event.sessionId,
        event.payload
      );
    });
  }, []);

  // Mounted here so it outlives any one session's subtree and background
  // sessions keep saving.
  useEffect(
    () =>
      startTranscriptPersistence((sessionId) =>
        workspaceConversationStore.getSegments(sessionId)
      ),
    []
  );
};

export const WorkspaceConversationProvider = ({
  sessionId,
  workspaceId,
  children,
}: {
  sessionId: string | null;
  workspaceId: string | null;
  children: ReactNode;
}): JSX.Element => {
  // Before first paint, so a command fired during this render can resolve
  // its workspace.
  if (sessionId != null && workspaceId != null) {
    workspaceConversationTransport.registerSession(sessionId, workspaceId);
  }

  // Replay the persisted transcript on first open this run.
  useEffect(() => {
    if (sessionId == null) return;
    void restoreTranscript(sessionId);
  }, [sessionId]);

  return (
    <ConversationProvider
      store={workspaceConversationStore}
      conversationId={sessionId}
    >
      {children}
    </ConversationProvider>
  );
};
