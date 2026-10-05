import { unwrapResult } from "../errors";
import { impl } from "./impl";

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
  diff: impl.git.diff.handler(({ input, context }) =>
    context.deps.serviceHost.getGitDiffForPath(input.filePath, input.scope)
  ),
});
