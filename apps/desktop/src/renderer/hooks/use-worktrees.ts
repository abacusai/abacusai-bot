import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type {
  AgentSessionListItem,
  WorktreeDraftEnvironment,
  WorktreeListItem,
} from "#shared/contracts";

import {
  LOCAL_CODE_QUERY_STALE_TIMES,
  workspaceQueryKeys,
} from "../lib/query-keys";

const idleWorkspaceId = "__idle__";

const resultError = (error: string | undefined, fallback: string): Error =>
  new Error(error ?? fallback);

export const worktreesQueryOptions = (workspaceId: string | null) =>
  queryOptions({
    queryKey: workspaceQueryKeys.worktrees(workspaceId ?? idleWorkspaceId),
    enabled: workspaceId != null,
    queryFn: async (): Promise<WorktreeListItem[]> => {
      if (workspaceId == null) return [];
      const result = await window.api.agent.listWorktrees({ workspaceId });
      if (!result.success) {
        throw resultError(result.error, "Unable to read Git worktrees.");
      }
      return result.worktrees;
    },
    staleTime: LOCAL_CODE_QUERY_STALE_TIMES.worktrees,
    placeholderData: (previousData) => previousData,
  });

export const useWorktreesQuery = (
  workspaceId: string | null,
  { enabled = true }: { enabled?: boolean } = {}
) =>
  useQuery({
    ...worktreesQueryOptions(workspaceId),
    enabled: enabled && workspaceId != null,
  });

const invalidateWorktreeSessionQueries = async (
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string
): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.worktrees(workspaceId),
    }),
    queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.agentSessions(workspaceId),
    }),
    queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.allAgentSessions,
    }),
  ]);
};

export const useSetSessionWorktreeMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      workspaceId: string;
      sessionId: string;
      worktreeId: string | null;
    }): Promise<AgentSessionListItem> => {
      const result = await window.api.agent.setSessionWorktree(params);
      if (!result.success || result.session == null) {
        throw resultError(result.error, "Unable to switch session worktree.");
      }
      return result.session;
    },
    onSuccess: async (_session, params) => {
      await invalidateWorktreeSessionQueries(queryClient, params.workspaceId);
    },
  });
};

export const useCreateWorktreeMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      workspaceId: string;
      baseRef: string;
      name?: string;
    }): Promise<WorktreeListItem> => {
      const result = await window.api.agent.createWorktree(params);
      if (!result.success || result.worktree == null) {
        throw resultError(result.error, "Unable to create Git worktree.");
      }
      return result.worktree;
    },
    onSuccess: async (_worktree, params) => {
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.worktrees(params.workspaceId),
      });
    },
  });
};

export interface PrepareSessionWorktreeParams {
  workspaceId: string;
  sessionId: string;
  environment: WorktreeDraftEnvironment;
}

export interface PreparedSessionWorktree {
  session: AgentSessionListItem;
  worktree: WorktreeListItem | null;
}

/**
 * Resolves a draft environment before starting the session that sends the
 * first message. The mutation is the single pending/error source for the UI.
 */
export const usePrepareSessionWorktreeMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      params: PrepareSessionWorktreeParams
    ): Promise<PreparedSessionWorktree> => {
      if (params.environment.kind === "new") {
        const result = await window.api.agent.materializeSessionWorktree({
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          baseRef: params.environment.baseRef,
          ...(params.environment.name != null
            ? { name: params.environment.name }
            : {}),
        });
        if (
          !result.success ||
          result.session == null ||
          result.worktree == null
        ) {
          throw resultError(
            result.error,
            "Unable to prepare the new Git worktree."
          );
        }
        return { session: result.session, worktree: result.worktree };
      }

      const worktreeId =
        params.environment.kind === "existing"
          ? params.environment.worktreeId
          : null;
      const result = await window.api.agent.setSessionWorktree({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        worktreeId,
      });
      if (!result.success || result.session == null) {
        throw resultError(result.error, "Unable to prepare session worktree.");
      }
      const worktree =
        params.environment.kind === "existing"
          ? (queryClient
              .getQueryData<WorktreeListItem[]>(
                workspaceQueryKeys.worktrees(params.workspaceId)
              )
              ?.find((entry) => entry.id === worktreeId) ?? null)
          : null;
      return { session: result.session, worktree };
    },
    onSuccess: async (_prepared, params) => {
      await invalidateWorktreeSessionQueries(queryClient, params.workspaceId);
    },
  });
};
