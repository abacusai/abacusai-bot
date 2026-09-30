import { unwrapResult } from "../errors";
import { impl } from "./impl";

export const workspacesRouter = impl.workspaces.router({
  add: impl.workspaces.add.handler(async ({ input, context }) => {
    const result = unwrapResult(
      await context.deps.serviceHost.addWorkspace(input.path, input.isRemote)
    );
    return { workspaceId: result.workspaceId ?? null };
  }),
  ensureSessionHome: impl.workspaces.ensureSessionHome.handler(
    async ({ context }) => ({
      workspaceId: await context.deps.serviceHost.ensureSessionHomeWorkspace(),
    })
  ),
  sessionHomePath: impl.workspaces.sessionHomePath.handler(({ context }) => ({
    path: context.deps.host.sessionHomePath(),
  })),
  switch: impl.workspaces.switch.handler(async ({ input, context }) => {
    unwrapResult(
      await context.deps.serviceHost.switchWorkspace(input.workspaceId)
    );
  }),
  checkPath: impl.workspaces.checkPath.handler(({ input, context }) =>
    context.deps.serviceHost.checkWorkspacePath(input.workspaceId)
  ),
  relocate: impl.workspaces.relocate.handler(async ({ input, context }) => {
    unwrapResult(
      await context.deps.serviceHost.relocateWorkspace(
        input.workspaceId,
        input.newPath
      )
    );
  }),
});
