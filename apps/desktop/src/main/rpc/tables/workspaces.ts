import type { WorkspaceRow } from "@abacus-ai/contract/contract/rows";

import type { TableSources } from "./sources";

export const readWorkspaceRows = (sources: TableSources): WorkspaceRow[] => {
  const { workspaces, activeWorkspaceId } = sources.getMetadata();
  return workspaces.map((workspace) => ({
    ...workspace,
    isActive: workspace.id === activeWorkspaceId,
  }));
};
