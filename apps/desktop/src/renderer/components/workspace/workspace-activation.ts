import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useWorkspaceStore } from "../../stores/code-store";

export interface WorkspaceConversationActivation {
  workspaceId: string;
  sessionId: string | null;
}

/**
 * Paint the selected conversation before main acknowledges the workspace;
 * reconciliation stays in the background and never invalidates other queries.
 */
export function activateWorkspaceConversation({
  target,
  currentWorkspaceId,
  activate,
  acknowledge,
}: {
  target: WorkspaceConversationActivation;
  currentWorkspaceId: string | null;
  activate: (target: WorkspaceConversationActivation) => boolean;
  acknowledge: (workspaceId: string) => Promise<unknown>;
}): boolean {
  if (!activate(target)) return false;
  if (currentWorkspaceId !== target.workspaceId) {
    void acknowledge(target.workspaceId).catch((error: unknown) => {
      console.error("Failed to reconcile workspace switch", error);
    });
  }
  return true;
}

/**
 * Open a conversation from anywhere. The pane is route state, so this must
 * navigate too or the click reads as dead.
 */
export function useConversationActivator(): (
  target: WorkspaceConversationActivation
) => boolean {
  const navigate = useNavigate();
  const activateWorkspaceSession = useWorkspaceStore(
    (state) => state.activateWorkspaceSession
  );
  return useCallback(
    (target: WorkspaceConversationActivation): boolean => {
      const activated = activateWorkspaceConversation({
        target,
        currentWorkspaceId: useWorkspaceStore.getState().activeWorkspaceId,
        activate: (next) =>
          activateWorkspaceSession(next.workspaceId, next.sessionId),
        acknowledge: (workspaceId) =>
          window.api.agent.switchWorkspace(workspaceId),
      });
      if (activated) {
        if (target.sessionId == null) {
          void navigate({ to: "/sessions/new" });
        } else {
          void navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: target.sessionId },
          });
        }
      }
      return activated;
    },
    [activateWorkspaceSession, navigate]
  );
}
