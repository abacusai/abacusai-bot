import { useMutation } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type {
  FileTreeRootSnapshot,
  GitStateSnapshot,
  WorkspaceMetadataSnapshot,
  WorkspaceState,
} from "#shared/contracts";

import { workspaceQueryKeys } from "../lib/query-keys";
import type {
  ExpandedDirectory,
  SwitchWorkspaceContext,
} from "../providers/workspace-state-types";
import {
  areExpandedDirectoriesEqual,
  buildOptimisticWorkspaceState,
  hydrateCachedWorkspaceState,
  normalizeWorkspaceSnapshot,
} from "../providers/workspace-state-utils";
import { useWorkspaceStore } from "../stores/code-store";
import {
  initialWorkspaceState,
  normalizeWorkspaceState,
} from "../utils/workspace-state";

const getWorkspaceQueryKey = (workspaceId: string | null): string =>
  workspaceId ?? "__idle__";

const buildWorkspaceStateFromQueryCache = (
  queryClient: ReturnType<typeof useQueryClient>
): WorkspaceState => {
  const metadata = queryClient.getQueryData<WorkspaceMetadataSnapshot>(
    workspaceQueryKeys.metadata
  );
  if (metadata == null) {
    return initialWorkspaceState;
  }

  const activeWorkspaceKey = getWorkspaceQueryKey(metadata.activeWorkspaceId);
  const gitState = queryClient.getQueryData<GitStateSnapshot>(
    workspaceQueryKeys.gitState(activeWorkspaceKey)
  );
  const fileTreeRoot = queryClient.getQueryData<FileTreeRootSnapshot>(
    workspaceQueryKeys.fileTreeRoot(activeWorkspaceKey)
  );

  return normalizeWorkspaceState({
    ...metadata,
    fileTree: fileTreeRoot?.fileTree ?? [],
    gitChanges: gitState?.gitChanges ?? [],
    gitAvailable: gitState?.gitAvailable ?? false,
    gitStatusMessage:
      gitState?.gitStatusMessage ?? initialWorkspaceState.gitStatusMessage,
    gitDiffHunks: [],
    lastUpdatedAt:
      [
        metadata.lastUpdatedAt,
        gitState?.lastUpdatedAt,
        fileTreeRoot?.lastUpdatedAt,
      ]
        .filter((value): value is string => typeof value === "string")
        .sort()
        .at(-1) ?? metadata.lastUpdatedAt,
  });
};

const setWorkspaceResourceQueries = (
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceState: WorkspaceState
): void => {
  const activeWorkspaceKey = getWorkspaceQueryKey(
    workspaceState.activeWorkspaceId
  );
  queryClient.setQueryData(workspaceQueryKeys.metadata, {
    workspaces: workspaceState.workspaces,
    activeWorkspaceId: workspaceState.activeWorkspaceId,
    worktrees: workspaceState.worktrees,
    sessions: workspaceState.sessions,
    chats: workspaceState.chats,
    utilityTabs: workspaceState.utilityTabs,
    agentRuns: workspaceState.agentRuns,
    materialIconsBasePath: workspaceState.materialIconsBasePath,
    lastUpdatedAt: workspaceState.lastUpdatedAt,
  });
  queryClient.setQueryData(workspaceQueryKeys.gitState(activeWorkspaceKey), {
    gitChanges: workspaceState.gitChanges,
    gitAvailable: workspaceState.gitAvailable,
    gitStatusMessage: workspaceState.gitStatusMessage,
    lastUpdatedAt: workspaceState.lastUpdatedAt,
  });
  queryClient.setQueryData(
    workspaceQueryKeys.fileTreeRoot(activeWorkspaceKey),
    {
      fileTree: workspaceState.fileTree,
      lastUpdatedAt: workspaceState.lastUpdatedAt,
    }
  );
};

export const useWorkspaceWorkspaceMutations = (
  activeWorkspaceId: string | null
) => {
  const queryClient = useQueryClient();

  // Zustand (code-store.ts) owns activeWorkspaceId and is flipped before this
  // runs; this only acks the switch to main and refreshes per-workspace caches.
  const switchWorkspaceMutation = useMutation<
    unknown,
    Error,
    string,
    SwitchWorkspaceContext
  >({
    mutationKey: ["local-code", "switch-workspace"],
    mutationFn: async (workspaceId) => {
      const result = await window.api.agent.switchWorkspace(workspaceId);
      if (!result.success) {
        throw new Error(result.error ?? "Unable to switch workspace.");
      }
      return result;
    },
    onMutate: async (workspaceId) => {
      await queryClient.cancelQueries({
        queryKey: workspaceQueryKeys.metadata,
      });
      await queryClient.cancelQueries({
        queryKey: workspaceQueryKeys.gitStateRoot,
      });
      await queryClient.cancelQueries({
        queryKey: workspaceQueryKeys.fileTreeRootRoot,
      });

      const previousWorkspaceState =
        buildWorkspaceStateFromQueryCache(queryClient);
      const previousWorkspaceId = previousWorkspaceState.activeWorkspaceId;

      if (previousWorkspaceId != null) {
        const previousSnapshot = normalizeWorkspaceSnapshot(
          queryClient.getQueryData(
            workspaceQueryKeys.workspaceSnapshot(previousWorkspaceId)
          ),
          previousWorkspaceState
        );
        queryClient.setQueryData(
          workspaceQueryKeys.workspaceSnapshot(previousWorkspaceId),
          {
            workspaceState: previousWorkspaceState,
            expandedDirectories: previousSnapshot.expandedDirectories,
          }
        );
      }

      // Seed the per-workspace caches optimistically so the explorer shows the
      // new workspace at once. activeWorkspaceId stays untouched: Zustand owns it.
      const cachedSnapshotData = queryClient.getQueryData(
        workspaceQueryKeys.workspaceSnapshot(workspaceId)
      );
      if (cachedSnapshotData != null) {
        const cachedSnapshot = normalizeWorkspaceSnapshot(
          cachedSnapshotData,
          previousWorkspaceState
        );
        const nextWorkspaceState = hydrateCachedWorkspaceState(
          cachedSnapshot.workspaceState,
          previousWorkspaceState,
          workspaceId
        );
        setWorkspaceResourceQueries(queryClient, nextWorkspaceState);
      } else {
        const nextWorkspaceState = buildOptimisticWorkspaceState(
          previousWorkspaceState,
          workspaceId
        );
        setWorkspaceResourceQueries(queryClient, nextWorkspaceState);
      }

      return { previousWorkspaceState, previousWorkspaceId };
    },
    onError: (_error, _workspaceId, context) => {
      if (context == null) {
        return;
      }
      setWorkspaceResourceQueries(queryClient, context.previousWorkspaceState);
    },
    onSuccess: async (_, workspaceId) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.metadata,
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.gitState(
            getWorkspaceQueryKey(workspaceId)
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.fileTreeRoot(
            getWorkspaceQueryKey(workspaceId)
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.gitBranchesRoot,
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.gitCurrentBranchRoot,
        }),
      ]);
    },
  });

  // Not awaited: `invalidateQueries` resolves only when the refetches finish,
  // which on a large folder holds a button mid-click for seconds of work the
  // user is not waiting on. The renderer state is already flipped.
  const refreshWorkspaceQueries = (): void => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.metadata }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitStateRoot,
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.fileTreeRootRoot,
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitBranchesRoot,
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitCurrentBranchRoot,
      }),
    ]).catch(() => undefined);
  };

  const addWorkspaceMutation = useMutation({
    mutationKey: ["local-code", "add-workspace"],
    mutationFn: async (path: string) => {
      const result = await window.api.agent.addWorkspace(path, false);
      if (!result.success) {
        throw new Error(result.error ?? "Unable to add workspace.");
      }
      return result;
    },
    onSuccess: async (result) => {
      // Flip the renderer synchronously: a fast user can send a message before
      // the metadata refetch arrives, and it would land on the old workspace.
      const newWid = result.workspaceId;
      if (newWid != null) {
        useWorkspaceStore.getState().activateWorkspaceSession(newWid, null);
      }
      refreshWorkspaceQueries();
    },
  });

  const addLocalWorkspace = async (): Promise<void> => {
    const selected = await window.api.openFolderDialog();
    if (selected == null) {
      return;
    }
    await addWorkspaceMutation.mutateAsync(selected);
  };

  const switchWorkspace = async (workspaceId: string): Promise<void> => {
    const pendingWorkspaceId = switchWorkspaceMutation.isPending
      ? (switchWorkspaceMutation.variables ?? null)
      : null;
    if (
      workspaceId === activeWorkspaceId ||
      workspaceId === pendingWorkspaceId
    ) {
      return;
    }
    await switchWorkspaceMutation.mutateAsync(workspaceId);
  };

  const setDirectoryOpen = useCallback(
    (directory: ExpandedDirectory, isOpen: boolean): void => {
      if (activeWorkspaceId == null) {
        return;
      }

      queryClient.setQueryData(
        workspaceQueryKeys.workspaceSnapshot(
          getWorkspaceQueryKey(activeWorkspaceId)
        ),
        (current: unknown) => {
          const currentSnapshot = normalizeWorkspaceSnapshot(
            current,
            buildWorkspaceStateFromQueryCache(queryClient)
          );
          const nextExpandedDirectories = isOpen
            ? currentSnapshot.expandedDirectories.some(
                (entry) => entry.id === directory.id
              )
              ? currentSnapshot.expandedDirectories
              : [...currentSnapshot.expandedDirectories, directory]
            : currentSnapshot.expandedDirectories.filter(
                (entry) =>
                  entry.id !== directory.id &&
                  !entry.path.startsWith(`${directory.path}/`)
              );

          if (
            areExpandedDirectoriesEqual(
              currentSnapshot.expandedDirectories,
              nextExpandedDirectories
            )
          ) {
            return current;
          }

          return {
            workspaceState: currentSnapshot.workspaceState,
            expandedDirectories: nextExpandedDirectories,
          };
        }
      );
    },
    [activeWorkspaceId, queryClient]
  );

  const removeWorkspaceMutation = useMutation({
    mutationKey: ["local-code", "remove-workspace"],
    mutationFn: async (workspaceId: string) => {
      const result = await window.api.agent.removeWorkspace(workspaceId);
      if (!result.success) {
        throw new Error(result.error ?? "Unable to remove workspace.");
      }
      return result;
    },
    onSuccess: async () => {
      refreshWorkspaceQueries();
    },
  });

  const renameWorkspaceMutation = useMutation({
    mutationKey: ["local-code", "rename-workspace"],
    mutationFn: async ({
      workspaceId,
      label,
    }: {
      workspaceId: string;
      label: string;
    }) => {
      const result = await window.api.agent.updateWorkspaceLabel(
        workspaceId,
        label
      );
      if (!result.success) {
        throw new Error(result.error ?? "Unable to rename workspace.");
      }
      return result;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.metadata,
      });
    },
  });

  // Repoint at another folder, keeping the workspace id (and so its chats).
  const relocateWorkspaceMutation = useMutation({
    mutationKey: ["local-code", "relocate-workspace"],
    mutationFn: async ({
      workspaceId,
      newPath,
    }: {
      workspaceId: string;
      newPath: string;
    }) => {
      const result = await window.api.agent.relocateWorkspace(
        workspaceId,
        newPath
      );
      if (!result.success) {
        throw new Error(result.error ?? "Unable to relocate workspace.");
      }
      return result;
    },
    onSuccess: async () => {
      refreshWorkspaceQueries();
    },
  });

  return {
    addLocalWorkspace,
    switchWorkspace,
    setDirectoryOpen,
    removeWorkspaceMutation,
    renameWorkspaceMutation,
    relocateWorkspaceMutation,
  };
};
