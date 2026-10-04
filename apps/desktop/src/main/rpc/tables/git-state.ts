import { checkoutKey } from "@abacus-ai/contract/contract/checkout";
import type { GitStateRow } from "@abacus-ai/contract/contract/rows";

import type { TableSources } from "./sources";

/**
 * One row per checkout (spec 04 §26.4 b), keyed by `checkoutKey`:
 *
 * - the active workspace's primary checkout, from the legacy runtime's
 *   snapshot (at most one row, none without an active workspace; a switch
 *   deletes the old row and inserts the new one);
 * - every checkout with a live `git.watch` (`sources.checkoutRows`), except
 *   one that is that same primary checkout, whose row is the runtime's.
 *
 * The runtime's snapshot is refreshed asynchronously, so for a moment after
 * the active workspace changes (a workspace added, the active one deleted)
 * it still describes the previous workspace. No primary row is published
 * until it describes the active one: the previous workspace's changes never
 * appear under the new id.
 */
export const readGitStateRows = (sources: TableSources): GitStateRow[] => {
  const rows: GitStateRow[] = [];
  const { activeWorkspaceId, workspaces } = sources.getMetadata();
  let primaryKey: string | null = null;
  if (activeWorkspaceId != null) {
    const active = workspaces.find((entry) => entry.id === activeWorkspaceId);
    const expectedPath =
      active == null || active.isRemote === true ? null : (active.path ?? null);
    if (sources.gitStateWorkspacePath() === expectedPath) {
      primaryKey = checkoutKey(activeWorkspaceId, null);
      rows.push({
        ...sources.getGitState(),
        workspaceId: activeWorkspaceId,
        checkoutKey: primaryKey,
        checkoutPath: expectedPath,
      });
    }
  }
  for (const row of sources.checkoutRows?.() ?? [])
    if (row.checkoutKey !== primaryKey) rows.push(row);
  return rows;
};

/** `lastUpdatedAt` is stamped on every read; it is not a change. */
export const sameGitState = (a: GitStateRow, b: GitStateRow): boolean => {
  const { lastUpdatedAt: _a, ...left } = a;
  const { lastUpdatedAt: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
};
