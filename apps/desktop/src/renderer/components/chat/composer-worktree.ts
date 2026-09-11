import type {
  AgentSessionListItem,
  WorktreeDraftEnvironment,
} from "#shared/contracts";

import type { PreparedSessionWorktree } from "../../hooks/use-worktrees";

export const createPreparedComposerSession = async ({
  workspaceId,
  environment,
  createSession,
  prepareSession,
}: {
  workspaceId: string;
  environment: WorktreeDraftEnvironment;
  createSession: (workspaceId: string) => Promise<AgentSessionListItem>;
  prepareSession: (params: {
    workspaceId: string;
    sessionId: string;
    environment: WorktreeDraftEnvironment;
  }) => Promise<PreparedSessionWorktree>;
}): Promise<PreparedSessionWorktree> => {
  const session = await createSession(workspaceId);
  return prepareSession({
    workspaceId,
    sessionId: session.id,
    environment,
  });
};
