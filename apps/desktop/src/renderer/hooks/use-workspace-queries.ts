import { queryOptions, useQuery } from "@tanstack/react-query";

import type { SessionTurnStateSnapshot } from "#shared/contracts";

import {
  workspaceQueryKeys,
  LOCAL_CODE_QUERY_STALE_TIMES,
} from "../lib/query-keys";
import { useWorkspaceStore } from "../stores/code-store";

const getWorkspaceQueryKey = (activeWorkspaceId: string | null): string =>
  activeWorkspaceId ?? "__idle__";

export const workspaceMetadataQueryOptions = () =>
  queryOptions({
    queryKey: workspaceQueryKeys.metadata,
    queryFn: async () => window.api.agent.getMetadata(),
    staleTime: LOCAL_CODE_QUERY_STALE_TIMES.metadata,
    placeholderData: (previousData) => previousData,
  });

export const useWorkspaceMetadataQuery = () => {
  return useQuery(workspaceMetadataQueryOptions());
};

/**
 * The one folder bots work in, created on first ask. A bot has no project to
 * be pointed at, so its folder is settled in advance. `enabled` is the whole
 * of "first ask": nothing is created until the pane that runs there is shown.
 */
export const useBotWorkspaceIdQuery = (enabled: boolean) =>
  useQuery({
    queryKey: workspaceQueryKeys.botWorkspaceId,
    queryFn: () => window.api.agent.ensureBotWorkspace(),
    enabled,
    staleTime: Infinity,
  });

// Zustand, not the metadata query: the query lags a user-driven switch by a
// refetch, long enough for a send in W2 to land in W1. Zustand is updated
// synchronously by the switch/add handlers.
export const useWorkspaceActiveWorkspaceId = (): string | null => {
  return useWorkspaceStore((s) => s.activeWorkspaceId);
};

// Re-checked on focus rather than cached: the folder can be deleted or renamed
// outside the app, and a stale "exists" lets a send through into a dead cwd.
export const useWorkspacePathStatusQuery = (
  activeWorkspaceId: string | null
) => {
  return useQuery({
    queryKey: workspaceQueryKeys.workspacePathStatus(
      getWorkspaceQueryKey(activeWorkspaceId)
    ),
    enabled: activeWorkspaceId != null,
    queryFn: async () =>
      window.api.agent.checkWorkspacePath(activeWorkspaceId as string),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
};

export const useWorkspaceGitStateQuery = ({
  activeWorkspaceId,
  enabled = true,
}: {
  activeWorkspaceId: string | null;
  enabled?: boolean;
}) => {
  return useQuery({
    queryKey: workspaceQueryKeys.gitState(
      getWorkspaceQueryKey(activeWorkspaceId)
    ),
    enabled: enabled && activeWorkspaceId != null,
    queryFn: async () => window.api.agent.getGitState(),
    staleTime: LOCAL_CODE_QUERY_STALE_TIMES.gitState,
    placeholderData: (previousData) => previousData,
  });
};

export const useWorkspaceFileTreeRootQuery = ({
  activeWorkspaceId,
  enabled = true,
}: {
  activeWorkspaceId: string | null;
  enabled?: boolean;
}) => {
  return useQuery({
    queryKey: workspaceQueryKeys.fileTreeRoot(
      getWorkspaceQueryKey(activeWorkspaceId)
    ),
    enabled: enabled && activeWorkspaceId != null,
    queryFn: async () => window.api.agent.getFileTreeRoot(),
    staleTime: LOCAL_CODE_QUERY_STALE_TIMES.fileTreeRoot,
    placeholderData: (previousData) => previousData,
  });
};

export const useWorkspaceAgentSessionsQuery = (
  workspaceId: string | null,
  { enabled = true }: { enabled?: boolean } = {}
) => {
  const workspaceKey = getWorkspaceQueryKey(workspaceId);
  return useQuery({
    queryKey: workspaceQueryKeys.agentSessions(workspaceKey),
    enabled: enabled && workspaceId != null,
    queryFn: async () => {
      if (workspaceId == null) {
        return [];
      }
      return window.api.agent.listAgentSessions(workspaceId);
    },
    staleTime: 2_000,
    placeholderData: (previousData) => previousData,
  });
};

export const allAgentSessionsQueryOptions = () =>
  queryOptions({
    queryKey: workspaceQueryKeys.allAgentSessions,
    queryFn: () => window.api.agent.listAllAgentSessions(),
    staleTime: 5_000,
    placeholderData: (prev) => prev,
  });

export const useAllAgentSessionsQuery = () => {
  return useQuery(allAgentSessionsQueryOptions());
};

// Every workspace: the Artifacts view exists to find a file when you no
// longer remember which chat produced it.
export const sessionArtifactsQueryOptions = () =>
  queryOptions({
    queryKey: workspaceQueryKeys.sessionArtifacts,
    queryFn: () => window.api.agent.listSessionArtifacts(),
    staleTime: 5_000,
    placeholderData: (prev) => prev,
  });

export const useSessionArtifactsQuery = () => {
  return useQuery(sessionArtifactsQueryOptions());
};

export const useAgentSessionStateQuery = (
  workspaceId: string | null,
  sessionId: string | null
) => {
  return useQuery({
    queryKey: workspaceQueryKeys.cliSessionState(
      getWorkspaceQueryKey(workspaceId),
      sessionId ?? "__null__"
    ),
    enabled: workspaceId != null && sessionId != null,
    queryFn: async () => {
      if (workspaceId == null || sessionId == null) {
        return null;
      }
      return window.api.agent.getAgentSessionState({
        workspaceId,
        sessionId,
      });
    },
    staleTime: LOCAL_CODE_QUERY_STALE_TIMES.cliSessionState,
    placeholderData: (previousData) => previousData,
  });
};

// The one source for "is this session busy?". Send/stop set it optimistically;
// main's `session-turn-state-updated` keeps the cache honest.
export const useSessionTurnStateQuery = (
  workspaceId: string | null,
  sessionId: string | null
) => {
  return useQuery<SessionTurnStateSnapshot>({
    queryKey:
      sessionId != null
        ? workspaceQueryKeys.sessionTurnState(sessionId)
        : workspaceQueryKeys.sessionTurnStateRoot,
    enabled: workspaceId != null && sessionId != null,
    queryFn: async () => {
      if (workspaceId == null || sessionId == null) {
        // Unreachable while disabled; TS demands a return.
        return {
          sessionId: sessionId ?? "",
          workspaceId: workspaceId ?? "",
          phase: "idle",
          isBusy: false,
          updatedAt: new Date().toISOString(),
        };
      }
      return window.api.agent.getSessionTurnState(workspaceId, sessionId);
    },
    staleTime: LOCAL_CODE_QUERY_STALE_TIMES.sessionTurnState,
    placeholderData: (previousData) => previousData,
  });
};
