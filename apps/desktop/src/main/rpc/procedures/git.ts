import type { GitWatchEvent } from "@abacus-ai/contract/contract/git";

import { unwrapResult } from "../errors";
import { impl, stream } from "./impl";

export const gitRouter = impl.git.router({
  worktrees: {
    list: impl.git.worktrees.list.handler(({ input, context }) =>
      context.deps.serviceHost.listWorktrees(input.workspaceId)
    ),
    create: impl.git.worktrees.create.handler(({ input, context }) =>
      context.deps.serviceHost.createWorktree(input)
    ),
    setForSession: impl.git.worktrees.setForSession.handler(
      ({ input, context }) => context.deps.serviceHost.setSessionWorktree(input)
    ),
    materialize: impl.git.worktrees.materialize.handler(({ input, context }) =>
      context.deps.serviceHost.materializeSessionWorktree(input)
    ),
  },
  branches: impl.git.branches.handler(({ input, context }) =>
    context.deps.serviceHost.getGitBranches(input)
  ),
  currentBranch: impl.git.currentBranch.handler(({ input, context }) =>
    context.deps.serviceHost.getGitCurrentBranch(input)
  ),
  prInfo: impl.git.prInfo.handler(({ input, context }) =>
    context.deps.serviceHost.getPrInfo(input)
  ),
  switchBranch: impl.git.switchBranch.handler(async ({ input, context }) => {
    const { currentBranch } = unwrapResult(
      await context.deps.serviceHost.switchGitBranch(
        input.branchName,
        input.context
      )
    );
    return { currentBranch };
  }),
  createBranch: impl.git.createBranch.handler(async ({ input, context }) => {
    const { currentBranch } = unwrapResult(
      await context.deps.serviceHost.createGitBranch(
        input.branchName,
        input.context
      )
    );
    return { currentBranch };
  }),
  // Without `checkout`: the legacy active workspace, with the kind derived
  // by the same checkout-aware reader (the legacy IPC keeps its string).
  diff: impl.git.diff.handler(({ input, context }) => {
    const { serviceHost } = context.deps;
    return input.checkout == null
      ? serviceHost.getActiveGitDiff(input.filePath, input.scope)
      : serviceHost.checkouts.diff(input.checkout, input.filePath, input.scope);
  }),
  discard: impl.git.discard.handler(async ({ input, context }) => {
    const result = await context.deps.serviceHost.checkouts.discard(
      input.checkout,
      input.entries
    );
    // The primary checkout's row is the runtime's: re-read it now.
    await context.deps.serviceHost.refreshGitState();
    context.deps.tables.gitState.notifyNow();
    return result;
  }),
  checkoutStatus: impl.git.checkoutStatus.handler(({ input, context }) =>
    context.deps.serviceHost.checkouts.status(input.checkout)
  ),
  watch: impl.git.watch.handler(({ input, context, signal }) => {
    // Resolved before the stream opens: an unknown checkout is NOT_FOUND.
    const watched = context.deps.serviceHost.checkouts.watch(input.checkout);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      watched.release();
    };
    signal?.addEventListener("abort", release, { once: true });
    const events = stream<GitWatchEvent>({
      path: "git.watch",
      context,
      signal,
      attach: () => release,
      initial: () => [{ type: "watching", checkoutKey: watched.key }],
    });
    return (async function* () {
      try {
        yield* events;
      } finally {
        release();
      }
    })();
  }),
});
