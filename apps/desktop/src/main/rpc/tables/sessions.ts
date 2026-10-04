import type { SessionRow } from "@abacus-ai/contract/contract/rows";

import type { TableSources } from "./sources";

/** Every session joined with its cached turn state (null: never seen busy). */
export const readSessionRows = (sources: TableSources): SessionRow[] => {
  const turns = new Map(
    sources.listSessionTurnStates().map((state) => [state.sessionId, state])
  );
  return sources.listAllAgentSessions().map((session) => {
    const turn = turns.get(session.id);
    return {
      ...session,
      worktreeOperationId: session.worktreeOperationId ?? null,
      turn:
        turn == null || turn.workspaceId !== session.workspaceId
          ? null
          : {
              phase: turn.phase,
              isBusy: turn.isBusy,
              updatedAt: turn.updatedAt,
            },
    };
  });
};

/** The event types that can change a session row. */
export const SESSION_EVENTS = [
  "local-cli-session-created",
  "local-cli-session-removed",
  "local-cli-session-updated",
  "local-cli-session-model-updated",
  "local-cli-session-conversation-id-updated",
  "local-cli-state-updated",
  "session-turn-state-updated",
] as const;
