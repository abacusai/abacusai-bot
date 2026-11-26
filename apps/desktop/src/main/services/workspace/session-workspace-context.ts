import path from "node:path";

import type { AgentSessionListItem } from "@abacus-ai/contract/contracts";

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
  return session.worktreePath == null
    ? workspacePath
    : sessionCheckoutDirectory(session);
};

/**
 * Where a session on a worktree works: the worktree, or the project's own
 * folder inside it when the project is a subfolder of its repository.
 */
export const sessionCheckoutDirectory = (
  session: Pick<AgentSessionListItem, "worktreePath" | "worktreeSubdir">
): string | null =>
  session.worktreePath == null
    ? null
    : session.worktreeSubdir == null
      ? session.worktreePath
      : path.join(session.worktreePath, session.worktreeSubdir);
