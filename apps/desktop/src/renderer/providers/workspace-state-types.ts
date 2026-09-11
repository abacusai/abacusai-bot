import type { WorkspaceState } from "#shared/contracts";

export type ExpandedDirectory = {
  id: string;
  path: string;
};

export type WorkspaceSnapshot = {
  workspaceState: WorkspaceState;
  expandedDirectories: ExpandedDirectory[];
};

export type SwitchWorkspaceContext = {
  previousWorkspaceState: WorkspaceState;
  previousWorkspaceId: string | null;
};
