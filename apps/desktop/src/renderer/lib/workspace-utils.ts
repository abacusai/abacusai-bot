import type { WorkspaceListItem } from "#shared/contracts";

/**
 * A workspace the app minted (e.g. the bot home under `~/.abacusai-bot/`)
 * rather than one the user chose. Session-side pickers hide these.
 */
export const isAppInternalWorkspace = (
  workspace: Pick<WorkspaceListItem, "path">
): boolean => {
  const p = workspace.path ?? "";
  return p.includes("/.abacusai-bot/") || p.includes("\\.abacusai-bot\\");
};
