import type { GitStateRow } from "#shared/contract/rows";

import type { TableSources } from "./sources";

/**
 * The active workspace's git state, the only one main computes today: at most
 * one row, and none without an active workspace. A switch deletes the old
 * row and inserts the new one.
 *
 * The runtime's snapshot is refreshed asynchronously, so for a moment after
 * the active workspace changes (a workspace added, the active one deleted)
 * it still describes the previous workspace. No row is published until it
 * describes the active one: the previous workspace's changes never appear
 * under the new id.
 */
export const readGitStateRows = (sources: TableSources): GitStateRow[] => {
  const { activeWorkspaceId, workspaces } = sources.getMetadata();
  if (activeWorkspaceId == null) return [];
  const active = workspaces.find((entry) => entry.id === activeWorkspaceId);
  const expectedPath =
    active == null || active.isRemote === true ? null : (active.path ?? null);
  if (sources.gitStateWorkspacePath() !== expectedPath) return [];
  return [{ ...sources.getGitState(), workspaceId: activeWorkspaceId }];
};

/** `lastUpdatedAt` is stamped on every read; it is not a change. */
export const sameGitState = (a: GitStateRow, b: GitStateRow): boolean => {
  const { lastUpdatedAt: _a, ...left } = a;
  const { lastUpdatedAt: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
};
