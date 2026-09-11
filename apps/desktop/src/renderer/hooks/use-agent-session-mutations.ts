import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AgentMode } from "#shared/agent-types";
import type {
  AgentSessionListItem,
  StartAgentSessionRequest,
  AgentSessionCommandRequest,
  SendAgentMessageRequest,
  AgentSetModelRequest,
  AgentSetModeRequest,
  SessionTurnStateSnapshot,
} from "#shared/contracts";

import { workspaceConversationTransport } from "../conversation/transport";
import { workspaceQueryKeys } from "../lib/query-keys";
import { useAgentSessionStore } from "../stores/agent-session-store";

const optimisticTurnState = (
  workspaceId: string,
  sessionId: string,
  phase: SessionTurnStateSnapshot["phase"]
): SessionTurnStateSnapshot => ({
  sessionId,
  workspaceId,
  phase,
  isBusy:
    phase === "pending" ||
    phase === "streaming" ||
    phase === "waiting_permission",
  updatedAt: new Date().toISOString(),
});

// While createAgentSession is in flight the sessions cache holds one of these
// beside the real rows; isPlaceholderSession() tells them apart.
export interface PlaceholderSession {
  id: string;
  label: string;
  isLoading: true;
  /** Absent on placeholders; declared so list-level sorts need not narrow. */
  conversationId?: null;
  createdAt?: string;
  updatedAt?: string;
}

export type AgentSessionEntry = AgentSessionListItem | PlaceholderSession;

export const isPlaceholderSession = (
  session: AgentSessionEntry
): session is PlaceholderSession =>
  "isLoading" in session && session.isLoading === true;

// Every write to the agentSessions cache goes through this: onSuccess and the
// local-cli-session-created event race and would otherwise produce two rows.
const dedupeById = <T extends { id: string }>(rows: T[]): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
};

export const useCreateSessionMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (workspaceId: string) => {
      return window.api.agent.createAgentSession(workspaceId);
    },
    onMutate: async (workspaceId: string) => {
      const queryKey = workspaceQueryKeys.agentSessions(workspaceId);
      const previousSessions =
        queryClient.getQueryData<AgentSessionEntry[]>(queryKey) ?? [];

      const placeholderId = `placeholder-${Date.now()}`;
      const placeholderSession: PlaceholderSession = {
        id: placeholderId,
        label: "New Chat...",
        isLoading: true,
      };

      queryClient.setQueryData(
        queryKey,
        dedupeById([placeholderSession, ...previousSessions])
      );

      return { previousSessions, placeholderId, workspaceId };
    },
    onSuccess: (session, workspaceId, context) => {
      // No setActiveSessionId here: the caller sets it against the workspace
      // active at click time, so a mid-mutation workspace switch cannot race.
      const queryKey = workspaceQueryKeys.agentSessions(workspaceId);
      queryClient.setQueryData(
        queryKey,
        (prev: AgentSessionEntry[] | undefined) => {
          if (prev == null) return [session];
          // The created event may already have prepended the real session.
          const filtered = prev.filter(
            (s) => s.id !== context?.placeholderId && s.id !== session.id
          );
          return dedupeById([session, ...filtered]);
        }
      );
    },
    onError: (_error, workspaceId, context) => {
      const queryKey = workspaceQueryKeys.agentSessions(workspaceId);
      queryClient.setQueryData(
        queryKey,
        (prev: AgentSessionEntry[] | undefined) => {
          if (prev == null) return [];
          return prev.filter((s) => s.id !== context?.placeholderId);
        }
      );
    },
  });
};

export const useStartCliSessionMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      workspaceId: string;
      sessionId: string;
      model?: string | null;
      mode?: AgentMode | null;
    }) => {
      const request: StartAgentSessionRequest = {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        ...(params.model != null && params.model.length > 0
          ? { model: params.model }
          : {}),
        ...(params.mode != null ? { mode: params.mode } : {}),
      };
      return window.api.agent.startAgentSession(request);
    },
    onSuccess: (_result, params) => {
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.cliSessionState(
          params.workspaceId,
          params.sessionId
        ),
      });
    },
  });
};

export const useUpdateSessionLabelMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      workspaceId: string;
      sessionId: string;
      label: string;
    }) => {
      return window.api.agent.updateAgentSessionLabel(
        params.workspaceId,
        params.sessionId,
        params.label
      );
    },
    onSuccess: (_result, params) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.agentSessions(params.workspaceId),
      });
    },
  });
};

export const useRemoveSessionMutation = (workspaceId: string | null) => {
  const queryClient = useQueryClient();
  const { clearSessionRuntime } = useAgentSessionStore();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      if (workspaceId == null) throw new Error("No workspace selected");
      await window.api.agent.stopAgentSession({
        workspaceId,
        sessionId,
      });
      return window.api.agent.removeAgentSession(workspaceId, sessionId);
    },
    onSuccess: (_result, sessionId) => {
      clearSessionRuntime(sessionId);
      queryClient.removeQueries({
        queryKey: workspaceQueryKeys.sessionTurnState(sessionId),
      });
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.agentSessions(workspaceId!),
      });
    },
  });
};

/** The one send failure the caller can recover from. */
export const UNDELIVERABLE_MESSAGE = "MessageUndeliverable";

const undeliverableMessageError = (): Error => {
  const error = new Error(UNDELIVERABLE_MESSAGE);
  error.name = UNDELIVERABLE_MESSAGE;
  return error;
};

export const isUndeliverableMessage = (error: unknown): boolean =>
  error instanceof Error && error.name === UNDELIVERABLE_MESSAGE;

export const useSendMessageMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: SendAgentMessageRequest) => {
      // False means no agent ever saw it (main already tried a restart). Thrown
      // so onError rolls back and the caller can return the text to the
      // composer instead of leaving a bubble waiting on a reply.
      const delivered = await window.api.agent.sendAgentMessage(params);
      if (!delivered) throw undeliverableMessageError();
      return delivered;
    },
    onMutate: async (params) => {
      // Flip the cached turn state so every consumer sees busy at once; main
      // overwrites it via session-turn-state-updated when the turn starts.
      queryClient.setQueryData(
        workspaceQueryKeys.sessionTurnState(params.sessionId),
        optimisticTurnState(params.workspaceId, params.sessionId, "pending")
      );
    },
    onError: (_error, params) => {
      queryClient.setQueryData(
        workspaceQueryKeys.sessionTurnState(params.sessionId),
        optimisticTurnState(params.workspaceId, params.sessionId, "idle")
      );
    },
  });
};

export const useStopTurnMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: AgentSessionCommandRequest) => {
      return window.api.agent.stopAgentTurn(params);
    },
    onMutate: (params) => {
      // Main suppresses in-flight events for the session, so idle sticks.
      queryClient.setQueryData(
        workspaceQueryKeys.sessionTurnState(params.sessionId),
        optimisticTurnState(params.workspaceId, params.sessionId, "idle")
      );
      // The suppressed `status_changed: idle` never reaches the store; without
      // this the status stays frozen, `canSend` stays false and the user is stuck.
      workspaceConversationTransport.markIdle(params.sessionId);
    },
    onSettled: (_result, _error, params) => {
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.cliSessionState(
          params.workspaceId,
          params.sessionId
        ),
      });
    },
  });
};

export const useSetCliModelMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: AgentSetModelRequest) => {
      return window.api.agent.setAgentModel(params);
    },
    onSuccess: (_result, params) => {
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.cliSessionState(
          params.workspaceId,
          params.sessionId
        ),
      });
    },
  });
};

export const useSetCliModeMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: AgentSetModeRequest) => {
      return window.api.agent.setAgentMode(params);
    },
    onSuccess: (_result, params) => {
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.cliSessionState(
          params.workspaceId,
          params.sessionId
        ),
      });
    },
  });
};
