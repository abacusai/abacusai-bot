/**
 * Whether a chat's folder is a code project: the one signal for what only
 * developers need (the project rules chip, the Terminal / Changes / Files
 * shortcuts, `/diff`). Everything stays reachable elsewhere; this only decides
 * what is put forward. No detection of its own: it reads what main and the
 * agent already report.
 */
import type { CheckoutRef } from "@abacus-ai/contract/contract/checkout";
import { useQuery } from "@tanstack/react-query";
import { Store, useStore } from "@tanstack/react-store";

import { useCheckoutQueries, useSession, useWorkspace } from "./queries";

const EMPTY: readonly string[] = [];

const slashed = (path: string): string =>
  path.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * Inside a git work tree, or the agent reads a rules file (AGENTS.md /
 * CLAUDE.md) kept in the folder itself. A rules file from a parent folder
 * (one in the home folder) is the person's, not this folder's: it does not
 * count, though the chip still names it.
 */
export const isCodeProject = (
  inGitWorkTree: boolean,
  projectRules: readonly string[],
  root: string | null | undefined
): boolean => {
  if (inGitWorkTree) return true;
  if (root == null || root === "") return false;
  const folder = `${slashed(root)}/`;
  return projectRules.some((file) => slashed(file).startsWith(folder));
};

/**
 * The signal for a chat (null before its row has loaded: false). The git
 * half is the context tray's own `git.currentBranch` query, which main
 * answers from its cached `rev-parse --is-inside-work-tree`, so it costs no
 * extra call where the tray is shown.
 */
export const useCodeProject = (
  checkout: CheckoutRef | null,
  /** The thread store's `projectRules`: what the chat's agent reads. */
  projectRules: readonly string[] = EMPTY
): boolean => {
  const ref = checkout ?? { workspaceId: "" };
  const options = useCheckoutQueries(ref);
  const branch = useQuery({
    ...options.branch(ref),
    enabled: checkout != null,
  });
  const session = useSession(checkout?.sessionId ?? "");
  const workspace = useWorkspace(checkout?.workspaceId ?? "");
  return isCodeProject(
    branch.data?.success === true,
    projectRules,
    session?.worktreePath ?? workspace?.path
  );
};

/**
 * Each session chat's signal as its route last computed it, for what sits
 * outside the chat (the command palette). Unknown: true, as before the signal.
 */
const codeProjects = new Store<Record<string, boolean>>({});

export const publishCodeProject = (sessionId: string, value: boolean): void => {
  if (codeProjects.state[sessionId] === value) return;
  codeProjects.setState((state) => ({ ...state, [sessionId]: value }));
};

export const usePublishedCodeProject = (sessionId: string | null): boolean =>
  useStore(codeProjects, (state) =>
    sessionId == null ? true : (state[sessionId] ?? true)
  );
