import type { WorkspaceState } from "#shared/contracts";

import { normalizeWorkspaceState } from "../utils/workspace-state";
import type {
  ExpandedDirectory,
  WorkspaceSnapshot,
} from "./workspace-state-types";

const LOADING_CHANGE_FILES_STATUS_MESSAGE = "Loading change files...";

const normalizeExpandedDirectories = (
  candidate: unknown
): ExpandedDirectory[] => {
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.flatMap((entry) => {
    if (entry == null || typeof entry !== "object") {
      return [];
    }

    const id = "id" in entry ? entry.id : null;
    const path = "path" in entry ? entry.path : null;
    if (typeof id !== "string" || typeof path !== "string") {
      return [];
    }

    return [{ id, path }];
  });
};

export const normalizeWorkspaceSnapshot = (
  candidate: unknown,
  fallbackWorkspaceState: WorkspaceState
): WorkspaceSnapshot => {
  if (candidate == null || typeof candidate !== "object") {
    return {
      workspaceState: fallbackWorkspaceState,
      expandedDirectories: [],
    };
  }

  const workspaceStateCandidate =
    "workspaceState" in candidate
      ? candidate.workspaceState
      : "shellState" in candidate
        ? candidate.shellState
        : null;
  const expandedDirectoriesCandidate =
    "expandedDirectories" in candidate ? candidate.expandedDirectories : null;

  return {
    workspaceState: normalizeWorkspaceState(
      workspaceStateCandidate as WorkspaceState | null | undefined
    ),
    expandedDirectories: normalizeExpandedDirectories(
      expandedDirectoriesCandidate
    ),
  };
};

export const areExpandedDirectoriesEqual = (
  left: ExpandedDirectory[],
  right: ExpandedDirectory[]
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => {
    const rightEntry = right[index];
    return (
      rightEntry != null &&
      rightEntry.id === entry.id &&
      rightEntry.path === entry.path
    );
  });
};

export const buildOptimisticWorkspaceState = (
  workspaceState: WorkspaceState,
  workspaceId: string
): WorkspaceState => {
  return {
    ...workspaceState,
    workspaces: workspaceState.workspaces.map((workspace) => ({
      ...workspace,
      status: workspace.id === workspaceId ? "active" : "idle",
    })),
    activeWorkspaceId: workspaceId,
    worktrees: [],
    sessions: [],
    chats: [],
    fileTree: [],
    gitChanges: [],
    gitDiffHunks: [],
    gitAvailable: false,
    gitStatusMessage: LOADING_CHANGE_FILES_STATUS_MESSAGE,
    lastUpdatedAt: new Date().toISOString(),
  };
};

export const hydrateCachedWorkspaceState = (
  snapshotWorkspaceState: WorkspaceState,
  fallbackWorkspaceState: WorkspaceState,
  workspaceId: string
): WorkspaceState => {
  return {
    ...snapshotWorkspaceState,
    workspaces: fallbackWorkspaceState.workspaces.map((workspace) => {
      const snapshotWorkspace = snapshotWorkspaceState.workspaces.find(
        (entry) => entry.id === workspace.id
      );
      return {
        ...(snapshotWorkspace ?? workspace),
        status: workspace.id === workspaceId ? "active" : "idle",
      };
    }),
    activeWorkspaceId: workspaceId,
  };
};
