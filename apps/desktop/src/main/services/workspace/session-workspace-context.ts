import type { AgentSessionListItem } from "#shared/contracts";

export interface WorkspacePathContext {
  workspaceId: string;
  sessionId?: string;
}

/**
 * Resolve a conversation checkout without consulting global active-workspace
 * state. An unknown or cross-workspace session is rejected rather than being
 * silently redirected to the workspace root.
 */
export const resolveSessionWorkspacePath = (
  context: WorkspacePathContext,
  workspacePath: string | null,
  getSession: (sessionId: string) => AgentSessionListItem | null
): string | null => {
  if (workspacePath == null) return null;
  if (context.sessionId == null) return workspacePath;
  const session = getSession(context.sessionId);
  if (session == null || session.workspaceId !== context.workspaceId) {
    return null;
  }
  return session.worktreePath ?? workspacePath;
};
