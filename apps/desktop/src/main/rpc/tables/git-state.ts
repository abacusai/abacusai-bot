import type { GitStateRow } from "#shared/contract/rows";

import type { TableSources } from "./sources";

/**
 * The active workspace's git state, the only one main computes today: at most
 * one row, and none without an active workspace. A switch deletes the old
 * row and inserts the new one.
 */
export const readGitStateRows = (sources: TableSources): GitStateRow[] => {
  const { activeWorkspaceId } = sources.getMetadata();
  if (activeWorkspaceId == null) return [];
  return [{ ...sources.getGitState(), workspaceId: activeWorkspaceId }];
};

/** `lastUpdatedAt` is stamped on every read; it is not a change. */
export const sameGitState = (a: GitStateRow, b: GitStateRow): boolean => {
  const { lastUpdatedAt: _a, ...left } = a;
  const { lastUpdatedAt: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
};
